//! Redis-backed async-job store: shared job state / progress / cancel so any
//! API replica can serve any job (Phase 1 of ADR 0001 — compute still runs
//! in-process; only the state transport moves to Redis).
//!
//! - Job state lives in a Redis hash `shapley:whatif:state:{id}` (TTL'd).
//! - Cancellation is a separate key `shapley:whatif:cancel:{id}` so a worker's
//!   progress flush can never clobber a concurrent cancel.
//! - The in-process compute keeps using `network_shapley::ComputeControl`
//!   verbatim; a bridge task (in routes.rs) mirrors its progress into the hash
//!   and polls the cancel key into `control.cancel`.

use std::collections::HashMap;

use deadpool_redis::Pool;
use deadpool_redis::redis::{self, AsyncCommands};
use serde_json::{Value, json};

// Key builders + stream/queue constants live in `queue` (the single source of
// truth shared with the worker role) so api + worker can never drift apart.
use crate::queue::{self, JobKind, cancel_key, state_key};

/// Running-job whole-key TTL (seconds) for the `state:{id}` hash. Refreshed on
/// every progress/phase heartbeat (see `set_progress`/`set_phase`) so a running
/// job never expires out from under an active poll. Must exceed the worst-case
/// QUEUE wait (no heartbeats fire until a worker picks the job up): with a small
/// fixed worker pool a job can wait behind a couple of ~15-min solves, so 600s
/// was too low — a queued job expired before pickup.
///
/// Both TTLs are `i64` because `conn.expire` takes `i64`, and DERIVED from the
/// `queue` `u64` constants (lossless at these magnitudes) so `queue.rs` stays
/// the single source of truth — no hand-synced duplicate to drift.
const JOB_TTL_SECS: i64 = queue::JOB_TTL_SECS as i64;

/// Terminal-job whole-key TTL (seconds), re-set on `set_done`/`set_failed`/
/// `set_cancelled` so a finished job lingers this long for the client to fetch
/// the result (24h — come back the next day, PSYS-557). Not heartbeat-refreshed
/// once terminal; durable retrieval beyond it is the S3 result store.
const TERMINAL_TTL_SECS: i64 = queue::TERMINAL_TTL_SECS as i64;

/// Live progress counters mirrored to Redis on each bridge tick. The `batch_*`
/// fields describe the in-flight sampling batch so the snapshot can interpolate
/// a smooth percent within a batch instead of stepping once per batch.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProgressCounters {
    pub coalitions_solved: usize,
    pub samples_done: usize,
    pub max_samples: usize,
    pub batch_samples: usize,
    pub batch_total: usize,
    pub batch_solved: usize,
}

/// Cloneable handle to the Redis job store (wraps a connection pool).
#[derive(Clone)]
pub struct RedisJobStore {
    pool: Pool,
}

impl RedisJobStore {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }

    /// Borrow the underlying pool. The worker role takes a dedicated connection
    /// for the blocking `XREADGROUP` long-poll so a 5s park can't starve the
    /// pooled connections used for progress flushes / ACKs.
    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    /// API producer: persist the request as a TTL'd `payload:{job_id}` String,
    /// then `XADD` a tiny reference entry (job_id + payload_key + input_hash +
    /// enqueued_at + schema + kind) onto the capped work Stream. The heavy
    /// request body never goes inline — Streams live fully in RAM. Generic over
    /// the payload type (`SimulateRequest` / `LinkEstimateRequest`); `kind` tells
    /// the worker which to deserialize. Returns the idempotency hash (hex).
    pub async fn enqueue<T: serde::Serialize>(
        &self,
        job_id: &str,
        kind: JobKind,
        body: &T,
    ) -> anyhow::Result<String> {
        let input_hash_hex = self
            .store_payload(&queue::payload_key(job_id), body, queue::PAYLOAD_TTL_SECS)
            .await?;
        let entry =
            queue::StreamEntry::new(job_id.to_string(), kind, input_hash_hex.clone(), now_ms());
        self.xadd(&entry).await?;
        Ok(input_hash_hex)
    }

    /// Persist a payload String under an explicit key + TTL, returning the
    /// payload's idempotency hash (hex). Split out of [`Self::enqueue`] so the
    /// sweep handler can store the epoch input ONCE (long TTL) and then fan out
    /// children that all reference it. Serialize ONCE: handle its (practically
    /// impossible) failure here rather than silently downstream, and reuse the
    /// bytes for both the payload String and the hash so they always agree.
    pub async fn store_payload<T: serde::Serialize>(
        &self,
        key: &str,
        body: &T,
        ttl_secs: u64,
    ) -> anyhow::Result<String> {
        let payload = serde_json::to_string(body)?;
        let input_hash_hex = format!("{:016x}", queue::hash_payload(&payload));
        self.store_payload_raw(key, &payload, ttl_secs).await?;
        Ok(input_hash_hex)
    }

    /// Persist an already-serialized payload String under an explicit key + TTL.
    /// Split out of [`Self::store_payload`] so a handler that must hash the
    /// payload BEFORE deciding to enqueue (the simulate submit-time S3
    /// short-circuit) can serialize exactly once and reuse those bytes for both
    /// the idempotency hash and this write — the two can never disagree.
    pub async fn store_payload_raw(
        &self,
        key: &str,
        payload_json: &str,
        ttl_secs: u64,
    ) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let _: () = conn.set_ex(key, payload_json, ttl_secs).await?;
        Ok(())
    }

    /// Enqueue a sweep CHILD: XADD an entry whose `payload_key` references the
    /// parent sweep's already-stored shared payload — NO payload write of its
    /// own (that duplication is exactly what held the old sync handler's socket
    /// open). `input_hash_hex` is the per-child link-estimate hash (drives the
    /// S3 idempotency key), NOT the shared payload's hash.
    pub async fn enqueue_child(
        &self,
        job_id: &str,
        kind: JobKind,
        shared_payload_key: &str,
        focus: &str,
        input_hash_hex: &str,
    ) -> anyhow::Result<()> {
        let entry = queue::StreamEntry::new_child(
            job_id.to_string(),
            kind,
            shared_payload_key.to_string(),
            focus.to_string(),
            input_hash_hex.to_string(),
            now_ms(),
        );
        self.xadd(&entry).await
    }

    /// `XADD` an entry onto the capped work Stream (refs only — see `enqueue`).
    async fn xadd(&self, entry: &queue::StreamEntry) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let mut cmd = redis::cmd("XADD");
        cmd.arg(queue::STREAM_KEY)
            .arg("MAXLEN")
            .arg("~")
            .arg(queue::STREAM_MAXLEN)
            .arg("*");
        for (field, value) in &entry.to_field_pairs() {
            cmd.arg(*field).arg(value);
        }
        let _id: String = cmd.query_async(&mut conn).await?;
        Ok(())
    }

    /// Claim the in-flight dedup key for a link-estimate input hash
    /// (`SET NX EX` — atomic). `true` ⇒ this job owns the solve; `false` ⇒
    /// someone else got there first (use [`Self::get_inflight`] to attach).
    pub async fn try_claim_inflight(
        &self,
        input_hash_hex: &str,
        job_id: &str,
    ) -> anyhow::Result<bool> {
        let mut conn = self.pool.get().await?;
        let claimed: Option<String> = redis::cmd("SET")
            .arg(queue::inflight_key(input_hash_hex))
            .arg(job_id)
            .arg("NX")
            .arg("EX")
            .arg(queue::INFLIGHT_TTL_SECS)
            .query_async(&mut conn)
            .await?;
        Ok(claimed.is_some())
    }

    /// The job_id currently holding the in-flight claim for this hash, if any.
    pub async fn get_inflight(&self, input_hash_hex: &str) -> anyhow::Result<Option<String>> {
        let mut conn = self.pool.get().await?;
        Ok(conn.get(queue::inflight_key(input_hash_hex)).await?)
    }

    /// Release the in-flight claim (worker calls this on terminal states; the
    /// key's TTL is only the backstop for a worker that dies first).
    pub async fn clear_inflight(&self, input_hash_hex: &str) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let _: () = conn.del(queue::inflight_key(input_hash_hex)).await?;
        Ok(())
    }

    /// Refresh a (shared) payload's TTL — the worker calls this when it picks
    /// up a sweep child so a queue deeper than the TTL can never expire the
    /// payload out from under the children still waiting.
    pub async fn refresh_payload_ttl(&self, key: &str, ttl_secs: u64) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let _: () = conn.expire(key, ttl_secs as i64).await?;
        Ok(())
    }

    /// Idempotent consumer-group bootstrap (`XGROUP CREATE … $ MKSTREAM`).
    /// Tolerates `BUSYGROUP` so every worker can call it safely on startup.
    pub async fn ensure_group(&self) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let res: redis::RedisResult<()> = conn
            .xgroup_create_mkstream(queue::STREAM_KEY, queue::CONSUMER_GROUP, "$")
            .await;
        match res {
            Ok(()) => Ok(()),
            Err(e) if e.code() == Some("BUSYGROUP") => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Fetch + deserialize a job's payload into the caller-chosen type (the
    /// worker picks `SimulateRequest` / `LinkEstimateRequest` from the entry's
    /// `kind`). `None` if it expired (the worker treats a long-missing payload as
    /// a poison pill — see `worker.rs`).
    pub async fn get_payload<T: serde::de::DeserializeOwned>(
        &self,
        job_id: &str,
    ) -> anyhow::Result<Option<T>> {
        self.get_payload_by_key(&queue::payload_key(job_id)).await
    }

    /// Fetch + deserialize a payload by explicit key — the path sweep children
    /// take (their entry's `payload_key` references the parent sweep's shared
    /// payload, not one derived from their own job_id).
    pub async fn get_payload_by_key<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> anyhow::Result<Option<T>> {
        let mut conn = self.pool.get().await?;
        let raw: Option<String> = conn.get(key).await?;
        match raw {
            Some(s) => Ok(Some(serde_json::from_str(&s)?)),
            None => Ok(None),
        }
    }

    /// XADD an entry for a job whose payload was already persisted via
    /// [`Self::store_payload`] (the sweep handler's store-once path).
    pub async fn enqueue_ref(
        &self,
        job_id: &str,
        kind: JobKind,
        input_hash_hex: &str,
    ) -> anyhow::Result<()> {
        let entry = queue::StreamEntry::new(
            job_id.to_string(),
            kind,
            input_hash_hex.to_string(),
            now_ms(),
        );
        self.xadd(&entry).await
    }

    /// Idempotency-cache read as raw JSON (kind-agnostic — the worker republishes
    /// it verbatim via `set_done`, never re-typing it). No silent `.ok()`: a
    /// corrupt (non-JSON) entry is logged and treated as a miss so the worker
    /// recomputes rather than serving garbage.
    pub async fn result_cache_get(&self, input_hash_hex: &str) -> anyhow::Result<Option<Value>> {
        let mut conn = self.pool.get().await?;
        let raw: Option<String> = conn.get(queue::result_key(input_hash_hex)).await?;
        match raw {
            Some(s) => match serde_json::from_str::<Value>(&s) {
                Ok(r) => Ok(Some(r)),
                Err(e) => {
                    tracing::error!(error = %e, hash = input_hash_hex,
                        "corrupt result-cache entry — treating as miss");
                    Ok(None)
                }
            },
            None => Ok(None),
        }
    }

    /// Idempotency-cache write (TTL'd) of the already-serialized response JSON.
    /// The worker writes this BEFORE the terminal `set_done`, so a crash in the
    /// gap still leaves a cache hit for a clean redelivery instead of forcing a
    /// recompute.
    pub async fn result_cache_set(&self, input_hash_hex: &str, resp: &Value) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let _: () = conn
            .set_ex(
                queue::result_key(input_hash_hex),
                resp.to_string(),
                queue::RESULT_TTL_SECS,
            )
            .await?;
        Ok(())
    }

    /// Create a new job (state=running) and return its UUID.
    pub async fn create(&self) -> anyhow::Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut conn = self.pool.get().await?;
        let key = state_key(&id);
        redis::cmd("HSET")
            .arg(&key)
            .arg("state")
            .arg("running")
            .query_async::<()>(&mut conn)
            .await?;
        let _: () = conn.expire(&key, JOB_TTL_SECS).await?;
        Ok(id)
    }

    /// Mirror live progress counters. SINGLE HSET, counters ONLY — never the
    /// `state` field (so a progress flush can't clobber a concurrent cancel).
    /// Includes the in-flight-batch fields so the snapshot can interpolate a
    /// smooth percent within a batch (see [`ProgressCounters`]).
    pub async fn set_progress(&self, id: &str, p: ProgressCounters) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        redis::cmd("HSET")
            .arg(state_key(id))
            .arg("coalitions_solved")
            .arg(p.coalitions_solved)
            .arg("samples_done")
            .arg(p.samples_done)
            .arg("max_samples")
            .arg(p.max_samples)
            .arg("batch_samples")
            .arg(p.batch_samples)
            .arg("batch_total")
            .arg(p.batch_total)
            .arg("batch_solved")
            .arg(p.batch_solved)
            .query_async::<()>(&mut conn)
            .await?;
        // Heartbeat: refresh the whole-key TTL so a long-running job can't
        // expire out from under an active poll. Without this the state:{id}
        // hash hard-expires JOB_TTL_SECS after create() and the poll then 404s
        // ("job not found") while the worker is still computing.
        let _: () = conn.expire(state_key(id), JOB_TTL_SECS).await?;
        Ok(())
    }

    /// Set the current compute phase label (`"baseline"` | `"modified"`). A
    /// SINGLE HSET of one field — never touches `state` or the counters — so it
    /// composes with `set_progress` and the cancel key without clobbering.
    /// Lets the snapshot/UI say which phase the (per-phase 0–100%) bar reflects.
    pub async fn set_phase(&self, id: &str, phase: &str) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let _: () = conn.hset(state_key(id), "phase", phase).await?;
        // Heartbeat: also refresh the TTL on a phase transition (see set_progress).
        let _: () = conn.expire(state_key(id), JOB_TTL_SECS).await?;
        Ok(())
    }

    /// Terminal: store the result + state=done.
    pub async fn set_done(&self, id: &str, result: &Value) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let key = state_key(id);
        redis::cmd("HSET")
            .arg(&key)
            .arg("state")
            .arg("done")
            .arg("result")
            .arg(result.to_string())
            .query_async::<()>(&mut conn)
            .await?;
        let _: () = conn.expire(&key, TERMINAL_TTL_SECS).await?;
        Ok(())
    }

    pub async fn set_failed(&self, id: &str, error: &str) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let key = state_key(id);
        redis::cmd("HSET")
            .arg(&key)
            .arg("state")
            .arg("failed")
            .arg("error")
            .arg(error)
            .query_async::<()>(&mut conn)
            .await?;
        let _: () = conn.expire(&key, TERMINAL_TTL_SECS).await?;
        Ok(())
    }

    pub async fn set_cancelled(&self, id: &str) -> anyhow::Result<()> {
        let mut conn = self.pool.get().await?;
        let key = state_key(id);
        redis::cmd("HSET")
            .arg(&key)
            .arg("state")
            .arg("cancelled")
            .query_async::<()>(&mut conn)
            .await?;
        let _: () = conn.expire(&key, TERMINAL_TTL_SECS).await?;
        Ok(())
    }

    /// Request cancellation (separate key the compute's bridge task polls).
    /// Returns false if the job doesn't exist (so the handler can 404).
    pub async fn request_cancel(&self, id: &str) -> anyhow::Result<bool> {
        let mut conn = self.pool.get().await?;
        let exists: bool = conn.exists(state_key(id)).await?;
        if exists {
            // Cancel is meaningless after a terminal state, so the flag keeps the
            // running TTL (not TERMINAL_TTL_SECS).
            let _: () = conn.set_ex(cancel_key(id), 1, queue::JOB_TTL_SECS).await?;
        }
        Ok(exists)
    }

    /// Whether cancellation has been requested for this job.
    pub async fn is_cancelled(&self, id: &str) -> anyhow::Result<bool> {
        let mut conn = self.pool.get().await?;
        Ok(conn.exists(cancel_key(id)).await?)
    }

    /// JSON snapshot for `GET /jobs/{id}` (same shape the in-process store
    /// produced). Returns `None` if the job is unknown/expired.
    pub async fn snapshot(&self, id: &str) -> anyhow::Result<Option<Value>> {
        let mut conn = self.pool.get().await?;
        let map: HashMap<String, String> = conn.hgetall(state_key(id)).await?;
        if map.is_empty() {
            return Ok(None);
        }
        let get_usize = |k: &str| {
            map.get(k)
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(0)
        };
        let state = map.get("state").map(String::as_str).unwrap_or("running");

        let snapshot = match state {
            "done" => {
                let result = map
                    .get("result")
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    .unwrap_or(Value::Null);
                json!({ "state": "done", "progress": { "percent": 100.0 }, "result": result })
            }
            "failed" => json!({ "state": "failed", "error": map.get("error") }),
            "cancelled" => json!({ "state": "cancelled" }),
            _ => {
                let samples_done = get_usize("samples_done");
                let max_samples = get_usize("max_samples");
                let batch_samples = get_usize("batch_samples");
                let batch_total = get_usize("batch_total");
                let batch_solved = get_usize("batch_solved");
                let percent = running_percent(
                    samples_done,
                    max_samples,
                    batch_samples,
                    batch_total,
                    batch_solved,
                );
                json!({
                    "state": "running",
                    "progress": {
                        // Which phase the 0–100% bar reflects ("baseline" while a
                        // cold baseline is solved, "modified" for the what-if).
                        "phase": map.get("phase"),
                        "coalitions_solved": get_usize("coalitions_solved"),
                        // Denominator for the per-city reward path's coalition bar
                        // (total coalition-LPs = cities × 2^operators);
                        // `coalitions_solved / coalitions_total` ≈ `percent`/100.
                        "coalitions_total": max_samples,
                        "samples_done": samples_done,
                        "max_samples": max_samples,
                        "batch_samples": batch_samples,
                        "batch_total": batch_total,
                        "batch_solved": batch_solved,
                        "percent": percent,
                    }
                })
            }
        };
        Ok(Some(snapshot))
    }
}

/// Smooth, monotonic running-progress percent (0..=99) for the progress bar.
///
/// Completed-batch samples (`samples_done`) plus the IN-FLIGHT batch's
/// sample-share (`batch_samples / max_samples`) scaled by its solve fraction
/// (`batch_solved / batch_total`), as a percent of `max_samples`. This climbs as
/// each LP finishes — visible on every ~250ms bridge tick, including during the
/// long first batch — instead of stepping once per batch, and is continuous
/// across a batch boundary (the in-flight term reaching its full sample-share
/// equals the jump in `samples_done`). Capped at 99 until the job is `done`.
fn running_percent(
    samples_done: usize,
    max_samples: usize,
    batch_samples: usize,
    batch_total: usize,
    batch_solved: usize,
) -> f64 {
    if max_samples == 0 {
        return 0.0;
    }
    let in_flight = if batch_total > 0 {
        batch_samples as f64 * (batch_solved.min(batch_total) as f64 / batch_total as f64)
    } else {
        0.0
    };
    (((samples_done as f64 + in_flight) / max_samples as f64) * 100.0).clamp(0.0, 99.0)
}

/// Build an optional Redis job store from `REDIS_URL` (None disables `/jobs/*`).
pub fn store_from_env() -> Option<RedisJobStore> {
    let url = match std::env::var("REDIS_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            tracing::warn!(
                "REDIS_URL not set — async /jobs endpoints disabled (sync endpoints unaffected)"
            );
            return None;
        }
    };
    let mut cfg = deadpool_redis::Config::from_url(url);
    // Bound the pool + add a wait timeout so a Redis stall can't park callers
    // indefinitely on the FIFO waitlist. The progress bridge does ~2 pooled ops
    // every 250ms for a job's whole lifetime, alongside the worker's long-lived
    // read_conn, reclaim/ack, and any API replica's snapshot polls — without a
    // wait timeout a latency spike could cascade-stall every pooled caller.
    let mut pool_cfg = deadpool_redis::PoolConfig::new(16);
    pool_cfg.timeouts.wait = Some(std::time::Duration::from_secs(5));
    cfg.pool = Some(pool_cfg);
    match cfg.create_pool(Some(deadpool_redis::Runtime::Tokio1)) {
        Ok(pool) => {
            tracing::info!("Redis job store enabled");
            Some(RedisJobStore::new(pool))
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to build Redis pool — /jobs disabled");
            None
        }
    }
}

/// Unix epoch milliseconds for a stream entry's `enqueued_at` (observability /
/// queue-lag). Falls back to 0 before the epoch, which only affects telemetry.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::running_percent;

    const EPS: f64 = 1e-9;

    #[test]
    fn terminal_ttl_outlives_running_ttl_and_agrees_with_queue() {
        // Finished jobs must linger longer than a running job's heartbeat
        // window, and the `i64` jobs-side views must equal the `u64` queue-side
        // source of truth they are derived from (guards the derivation, not
        // Redis behavior). Const blocks so a broken relationship fails to
        // compile, not just at test time.
        const {
            assert!(super::TERMINAL_TTL_SECS > super::JOB_TTL_SECS);
            assert!(super::JOB_TTL_SECS as u64 == crate::queue::JOB_TTL_SECS);
            assert!(super::TERMINAL_TTL_SECS as u64 == crate::queue::TERMINAL_TTL_SECS);
        }
    }

    #[test]
    fn climbs_smoothly_within_first_batch() {
        // Batch 1: 40 of max 200 samples, 100 coalitions to solve.
        assert_eq!(running_percent(0, 200, 40, 0, 0), 0.0); // before Pass 1 (no target yet)
        assert_eq!(running_percent(0, 200, 40, 100, 0), 0.0); // batch start
        assert!((running_percent(0, 200, 40, 100, 25) - 5.0).abs() < EPS); // ¼ → 5%
        assert!((running_percent(0, 200, 40, 100, 50) - 10.0).abs() < EPS); // ½ → 10%
        assert!((running_percent(0, 200, 40, 100, 100) - 20.0).abs() < EPS); // full → 20%
    }

    #[test]
    fn continuous_across_batch_boundary() {
        // End of batch 1 (full in-flight) == start of batch 2 (samples_done bumped).
        let end_b1 = running_percent(0, 200, 40, 100, 100); // 20%
        let start_b2 = running_percent(40, 200, 50, 80, 0); // 20%
        assert!((end_b1 - start_b2).abs() < EPS);
    }

    #[test]
    fn caps_at_99_and_handles_zero_max() {
        assert_eq!(running_percent(0, 0, 0, 0, 0), 0.0);
        // Overshoot (shouldn't happen) is clamped below the done=100 marker.
        assert_eq!(running_percent(1000, 200, 50, 50, 50), 99.0);
    }

    #[test]
    fn guards_batch_solved_over_total() {
        // A transient batch_solved > batch_total can't exceed the batch's share.
        assert!((running_percent(0, 200, 40, 100, 999) - 20.0).abs() < EPS);
    }
}
