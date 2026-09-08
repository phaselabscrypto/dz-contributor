//! Redis Streams consumption, solver outcomes, and durable alias publication.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use deadpool_redis::redis::streams::{
    StreamAutoClaimOptions, StreamAutoClaimReply, StreamPendingCountReply, StreamReadOptions,
    StreamReadReply,
};
use deadpool_redis::redis::{self, AsyncCommands};

use network_shapley::shapley::ComputeControl;

use crate::cache;
use crate::jobs::RedisJobStore;
use crate::model::{
    BaselinePublishPayload, LinkEstimateRequest, LinkEstimateResponse, ShapleyInputIn,
    ShapleyResponse, SimulateRequest, SimulateResponse, SimulateStats, SweepPayload,
};
use crate::queue::{self, JobKind};
use crate::routes::{
    LinkEstimateError, PerCityError, SWEEP_MAX_FOCUS_LINKS, compute_and_store_baseline,
    compute_baseline, compute_per_city, count_focus_links, link_estimate_payload_hash,
    load_cached_epoch, reusable_city_values, try_cached_baseline,
};

/// Outcome of a single solve, so `process_entry` (not the compute) owns the
/// XACK / cache / state-write decisions.
enum Outcome {
    /// Solve finished — terminal `done`. Carries the response JSON (kind-agnostic:
    /// a `SimulateResponse` or `LinkEstimateResponse` already serialized to
    /// `Value`), which `process_entry` caches + publishes verbatim, then `XACK`s.
    Done(Box<serde_json::Value>),
    /// Cancelled cooperatively — terminal `cancelled`, `XACK`.
    Cancelled,
    /// Input-deterministic failure (`ShapleyError`): retrying the same input
    /// can't help → terminal `failed`, `XACK`.
    Deterministic(String),
    /// Transient failure (a `spawn_blocking` panic, e.g. memory pressure):
    /// leave the entry pending so the reclaim sweep retries it, bounded by
    /// [`queue::MAX_DELIVERIES`].
    Transient(String),
}

/// Run the worker consume loop forever (until the process is shut down).
pub async fn run(state: Arc<crate::AppState>) -> anyhow::Result<()> {
    let store = state
        .jobs
        .clone()
        .ok_or_else(|| anyhow::anyhow!("worker role requires REDIS_URL"))?;

    store.ensure_group().await?;
    let consumer = format!("worker-{}", uuid::Uuid::new_v4());
    tracing::info!(
        consumer,
        stream = queue::STREAM_KEY,
        group = queue::CONSUMER_GROUP,
        "worker consuming what-if stream"
    );

    // Dedicated connection for the blocking XREADGROUP long-poll so a 5s park
    // can't hold a pooled connection that progress flushes / ACKs need.
    let mut read_conn = store.pool().get().await?;
    let mut last_reclaim = std::time::Instant::now();
    // Exponential backoff on XREADGROUP failure (Redis flapping), reset on a
    // successful read — avoids both a hot error-loop and a fixed stall that
    // accumulates across many consecutive failures.
    const MIN_BACKOFF: std::time::Duration = std::time::Duration::from_millis(500);
    const MAX_BACKOFF: std::time::Duration = std::time::Duration::from_secs(5);
    let mut backoff = MIN_BACKOFF;

    loop {
        // Periodic crash-recovery: reclaim entries abandoned by dead workers.
        if last_reclaim.elapsed().as_millis() >= queue::RECLAIM_MIN_IDLE_MS as u128 {
            if let Err(e) = reclaim(&state, &store, &consumer).await {
                tracing::warn!(error = %e, "reclaim sweep failed");
            }
            last_reclaim = std::time::Instant::now();
        }

        let opts = StreamReadOptions::default()
            .group(queue::CONSUMER_GROUP, &consumer)
            .count(queue::READ_COUNT)
            .block(queue::READ_BLOCK_MS);
        // A BLOCK timeout yields a Nil reply → empty StreamReadReply (verified),
        // so an idle worker just re-blocks without churning.
        let reply: StreamReadReply = match read_conn
            .xread_options(&[queue::STREAM_KEY], &[">"], &opts)
            .await
        {
            Ok(r) => {
                backoff = MIN_BACKOFF; // healthy read → reset backoff
                r
            }
            Err(e) => {
                tracing::warn!(error = %e, backoff_ms = backoff.as_millis(), "xreadgroup failed; backing off");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        };

        for key in &reply.keys {
            for entry in &key.ids {
                // One bad entry must never kill the loop: log + continue. A
                // returned error leaves the entry pending for the reclaim sweep.
                if let Err(e) =
                    process_entry(&state, &store, &consumer, &entry.id, &entry.map).await
                {
                    tracing::error!(error = %e, entry_id = %entry.id, "entry processing error");
                }
            }
        }
    }
}

/// Process one delivered (or reclaimed) Stream entry end-to-end. Returns `Ok`
/// for every *compute* outcome — only genuine infra errors bubble (the caller
/// logs them and leaves the entry pending for reclaim).
async fn process_entry(
    state: &Arc<crate::AppState>,
    store: &RedisJobStore,
    consumer: &str,
    entry_id: &str,
    map: &HashMap<String, redis::Value>,
) -> anyhow::Result<()> {
    // 1. Parse. A malformed entry can never succeed → dead-letter + XACK.
    let entry = match queue::StreamEntry::from_field_map(map) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!(error = %e, entry_id, "malformed stream entry → dead-letter");
            dead_letter(store, "unknown", entry_id, "malformed").await?;
            ack(store, entry_id).await?;
            return Ok(());
        }
    };

    // 2. Unknown schema → dead-letter (don't risk mis-decoding a newer payload).
    if !entry.schema_supported() {
        tracing::error!(schema = %entry.schema, job_id = %entry.job_id,
            "unsupported entry schema → dead-letter");
        let _ = store
            .set_failed(&entry.job_id, "unsupported job schema")
            .await;
        dead_letter(store, &entry.job_id, entry_id, "bad-schema").await?;
        ack(store, entry_id).await?;
        return Ok(());
    }

    // The heartbeat covers everything from here to the terminal write, so a
    // long read or an awaited publication cannot look like an abandoned entry.
    let heartbeat = claim_heartbeat(store, consumer, entry_id, &entry);
    let mut shared: Option<SweepPayload> =
        if entry.kind == JobKind::LinkEstimate && entry.focus.is_some() {
            store.get_payload_by_key(&entry.payload_key).await?
        } else {
            None
        };
    let alias_tag = shared
        .as_ref()
        .and_then(SweepPayload::publish_tag)
        .map(str::to_owned);

    // 3. Idempotency: a cached result is republished instead of recomputed.
    //    Sweep and publish summaries are never cached (`is_result_cached`).
    if entry.kind.is_result_cached()
        && let Some(resp) = store.result_cache_get(&entry.input_hash).await?
        && reconcile_cached_result(state, store, &entry, alias_tag.as_deref(), &resp).await?
    {
        heartbeat.stop().await;
        store.set_done(&entry.job_id, &resp).await?;
        clear_inflight_for(store, &entry).await;
        ack(store, entry_id).await?;
        return Ok(());
    }

    // 4. A job whose state hash expired while QUEUED (waited > JOB_TTL_SECS —
    //    heartbeats only start after pickup) has no observer left: the client's
    //    polls have been 404ing and cancellation was impossible (request_cancel
    //    gates on the state key). Don't burn a potentially hours-long solve for
    //    nobody — recreate the state as a LOUD terminal failure and ack.
    if store.snapshot(&entry.job_id).await?.is_none() {
        tracing::warn!(job_id = %entry.job_id,
            "job state expired while queued — failing without compute");
        heartbeat.stop().await;
        store
            .set_failed(
                &entry.job_id,
                "job state expired before a worker picked it up (queued longer than the job \
                 TTL); resubmit",
            )
            .await?;
        clear_inflight_for(store, &entry).await;
        ack(store, entry_id).await?;
        return Ok(());
    }

    // 5. Compute. Dispatch on the entry's `kind` to deserialize the right payload
    //    and run the matching solve. A missing payload (TTL expired / never
    //    written) can't be retried into existence — leave it pending; the reclaim
    //    sweep's delivery-count guard dead-letters it after MAX_DELIVERIES.
    let outcome = match entry.kind {
        JobKind::Simulate => match store.get_payload::<SimulateRequest>(&entry.job_id).await? {
            Some(body) => run_simulate(state, store, &entry.job_id, body).await,
            None => {
                tracing::warn!(job_id = %entry.job_id, "payload missing — leaving pending for reclaim");
                return Ok(());
            }
        },
        JobKind::LinkEstimate => {
            let body: Option<LinkEstimateRequest> = match &entry.focus {
                Some(focus) => shared.take().map(|sweep| LinkEstimateRequest {
                    input: sweep.input,
                    operator_focus: focus.clone(),
                }),
                None => {
                    store
                        .get_payload::<LinkEstimateRequest>(&entry.job_id)
                        .await?
                }
            };
            match body {
                Some(body) => {
                    // Keep the shared payload alive for siblings still queued
                    // behind this (possibly hours-long) solve.
                    if entry.focus.is_some()
                        && let Err(e) = store
                            .refresh_payload_ttl(&entry.payload_key, queue::SWEEP_PAYLOAD_TTL_SECS)
                            .await
                    {
                        tracing::warn!(error = %e, "sweep payload TTL refresh failed (non-fatal)");
                    }
                    run_link_estimate(
                        state,
                        store,
                        &entry.job_id,
                        ResultKeys {
                            payload_hash_hex: &entry.input_hash,
                            alias_tag: alias_tag.as_deref(),
                        },
                        body,
                    )
                    .await
                }
                None => {
                    tracing::warn!(job_id = %entry.job_id, "payload missing — leaving pending for reclaim");
                    return Ok(());
                }
            }
        }
        JobKind::Sweep => match store.get_payload::<SweepPayload>(&entry.job_id).await? {
            Some(payload) => {
                run_sweep(state, store, &entry.job_id, &entry.payload_key, payload).await
            }
            None => {
                tracing::warn!(job_id = %entry.job_id, "payload missing — leaving pending for reclaim");
                return Ok(());
            }
        },
        JobKind::Baseline => match store.get_payload::<ShapleyInputIn>(&entry.job_id).await? {
            Some(input) => run_baseline(state, store, &entry.job_id, input).await,
            None => {
                tracing::warn!(job_id = %entry.job_id, "payload missing — leaving pending for reclaim");
                return Ok(());
            }
        },
        JobKind::BaselinePublish => {
            match store
                .get_payload::<BaselinePublishPayload>(&entry.job_id)
                .await?
            {
                Some(payload) => run_baseline_publish(state, store, &entry.job_id, payload).await,
                None => {
                    tracing::warn!(job_id = %entry.job_id, "payload missing — leaving pending for reclaim");
                    return Ok(());
                }
            }
        }
    };

    // 6. Terminal handling. process_entry owns the XACK/cache/state ordering,
    //    and the heartbeat stops before any terminal write.
    heartbeat.stop().await;
    match outcome {
        Outcome::Done(resp) => {
            // User-facing result first, then best-effort cache (so a cache-write
            // failure can't strand a finished result), then XACK. Sweep
            // summaries are NOT result-cached: a summary is a point-in-time
            // report, and a re-sweep must re-expand (cheap) to observe state
            // that changed since — caching it would serve stale bookkeeping.
            store.set_done(&entry.job_id, &resp).await?;
            if entry.kind.is_result_cached()
                && let Err(e) = store.result_cache_set(&entry.input_hash, &resp).await
            {
                tracing::warn!(error = %e, "result cache_set failed (non-fatal)");
            }
            // Durable simulate persistence (PSYS-557): a finished what-if is kept
            // in S3 forever, keyed by the same request hash the submit-time
            // short-circuit reads. Fire-and-forget inside `store_simulate`; a
            // parse or PUT failure can never fail the job (S3 is an optimization
            // layer — the user-facing result is already written above).
            if entry.kind == JobKind::Simulate
                && let Some(s3) = &state.s3_cache
            {
                match u64::from_str_radix(&entry.input_hash, 16) {
                    Ok(h) => s3.store_simulate(h, &resp),
                    Err(e) => tracing::error!(error = %e, hash = %entry.input_hash,
                        "simulate S3 store skipped — unparseable entry hash"),
                }
            }
            clear_inflight_for(store, &entry).await;
            ack(store, entry_id).await?;
        }
        Outcome::Cancelled => {
            store.set_cancelled(&entry.job_id).await?;
            clear_inflight_for(store, &entry).await;
            ack(store, entry_id).await?;
        }
        Outcome::Deterministic(msg) => {
            store.set_failed(&entry.job_id, &msg).await?;
            clear_inflight_for(store, &entry).await;
            ack(store, entry_id).await?;
        }
        Outcome::Transient(msg) => {
            // Don't XACK and don't write terminal state — the reclaim sweep
            // retries (bounded), and the job stays "running" to the client until
            // it succeeds or is dead-lettered. The inflight claim stays too:
            // the job IS still in flight.
            tracing::warn!(job_id = %entry.job_id, reason = %msg,
                "transient failure — leaving pending for bounded retry");
        }
    }
    Ok(())
}

/// Release a link-estimate's in-flight dedup claim on terminal states (the key
/// TTL is only the crash backstop). Best-effort: a failed DEL just delays the
/// next identical submit until the TTL, never blocks it forever. Other kinds
/// hold no claims.
async fn clear_inflight_for(store: &RedisJobStore, entry: &queue::StreamEntry) {
    if entry.kind == JobKind::LinkEstimate
        && let Err(e) = store.clear_inflight(&entry.input_hash).await
    {
        tracing::warn!(error = %e, job_id = %entry.job_id, "inflight clear failed (non-fatal)");
    }
}

/// The relocated what-if compute (was `routes::run_simulate_job`): baseline
/// (cache/compute) + cancellable modified solve, bridging `ComputeControl` ⇄
/// Redis. Returns an [`Outcome`]; does NOT write terminal state or XACK.
async fn run_simulate(
    state: &Arc<crate::AppState>,
    store: &RedisJobStore,
    job_id: &str,
    body: SimulateRequest,
) -> Outcome {
    // ── Progress bridge ─────────────────────────────────────────────────
    // Started BEFORE the baseline so a cold baseline solve also drives the bar
    // (instead of sitting at 0% for the whole phase). ONE `ComputeControl` +
    // bridge spans both phases: the bridge only reads `progress` atomics and
    // copies the Redis cancel flag into `control.cancel`, so it never blocks the
    // solve. We reset the counters and relabel `phase` at the handoff, giving a
    // per-phase 0–100% bar. `control` is moved into the blocking solves via cheap
    // Arc clones, so all phases share the same progress/cancel.
    let control = ComputeControl::default();
    let bridge = TaskGuard::spawn(bridge_control(
        store.clone(),
        job_id.to_string(),
        control.clone(),
    ));

    // ── Baseline (memory/S3 cache hit, else compute + store, with progress) ──
    let baseline_hash = cache::hash_input(&body.baseline);
    let _ = store.set_phase(job_id, "baseline").await;
    tracing::info!(job = %job_id, "shapley: baseline phase start");
    let baseline_start = std::time::Instant::now();
    let (baseline_response, baseline_cache_hit) = match try_cached_baseline(state, baseline_hash)
        .await
    {
        Some(resp) => (resp, true),
        None => {
            match compute_and_store_baseline(state, &body.baseline, baseline_hash, Some(&control))
                .await
            {
                Ok(resp) => (resp, false),
                Err(e) => {
                    bridge.stop().await;
                    // A cancel during the baseline surfaces as an error string;
                    // map it to Cancelled (terminal, XACK'd) rather than a failure.
                    if control.cancel.load(std::sync::atomic::Ordering::Relaxed) {
                        return Outcome::Cancelled;
                    }
                    return Outcome::Deterministic(format!("baseline: {e}"));
                }
            }
        }
    };
    let baseline_ms = baseline_start.elapsed().as_millis() as u64;
    tracing::info!(job = %job_id, baseline_ms, cache_hit = baseline_cache_hit, "shapley: baseline phase done");

    // ── Modified run (per-city EXACT, DZ-faithful) with cancel + progress ──
    // Reuse the baseline's per-city values for source cities this what-if didn't
    // change (`reusable_city_values`): a link/device edit touches the shared
    // topology and invalidates every city, but a pure demand-override reuses the
    // cities it left untouched. Provenance-checked by `input_hash`; empty ⇒ every
    // city solved fresh.
    let reuse: BTreeMap<String, Vec<(String, f64)>> = {
        let guard = state.epoch_cache.read().await;
        guard
            .as_ref()
            .filter(|c| c.input_hash == baseline_hash)
            .map(|c| reusable_city_values(&body.baseline, &body.modified, &c.per_city_values))
            .unwrap_or_default()
    };

    // ── Phase transition → modified ──────────────────────────────────────
    // Reset the shared counters so the modified bar starts at 0 (the same
    // `control`/bridge continue), and relabel the phase. `compute_per_city`
    // primes the per-city progress counters (one unit per source city). `reset()`
    // is plain atomic stores; a bridge tick racing it only renders a momentarily-
    // stale fraction, never a torn/invalid state.
    control.progress.reset();
    let _ = store.set_phase(job_id, "modified").await;
    tracing::info!(job = %job_id, reused_cities = reuse.len(), "shapley: modified phase start");

    let modified_input = body.modified.clone();
    let control_for_solve = control.clone();
    let modified_start = std::time::Instant::now();
    let mod_result = tokio::task::spawn_blocking(move || {
        compute_per_city(&modified_input, &reuse, Some(&control_for_solve))
    })
    .await;
    let modified_ms = modified_start.elapsed().as_millis() as u64;
    bridge.stop().await;

    match mod_result {
        Ok(Ok(per_city_result)) => {
            tracing::info!(
                job = %job_id,
                modified_ms,
                cities_solved = per_city_result.cities_solved,
                cities_reused = per_city_result.cities_reused,
                "shapley: modified phase done"
            );
            let values = per_city_result.aggregated;
            let modified_response = ShapleyResponse {
                method: per_city_result.method,
                operator_count: values.len(),
                values,
            };
            let resp = SimulateResponse {
                baseline: baseline_response,
                modified: modified_response,
                stats: SimulateStats {
                    baseline_cache_hit,
                    // Per-CITY counts (the unit of reuse under the per-city
                    // model); wire field names kept for stability — see the
                    // `SimulateStats` docs.
                    coalitions_reused: per_city_result.cities_reused,
                    coalitions_solved: per_city_result.cities_solved,
                    baseline_ms,
                    modified_ms,
                },
            };
            Outcome::Done(Box::new(
                serde_json::to_value(resp).expect("SimulateResponse serializes to JSON"),
            ))
        }
        // Cooperative cancel observed between cities → terminal cancelled.
        Ok(Err(PerCityError::Cancelled)) => Outcome::Cancelled,
        // Any other failure is a deterministic function of the input.
        Ok(Err(PerCityError::Failed(msg))) => Outcome::Deterministic(format!("modified: {msg}")),
        // spawn_blocking JoinError = a panic (e.g. OOM): possibly transient.
        Err(_) => Outcome::Transient("modified task panicked".to_string()),
    }
}

/// Where a finished link-estimate gets filed in S3.
#[derive(Clone, Copy)]
struct ResultKeys<'a> {
    /// The stream entry's `input_hash`; names the result object.
    payload_hash_hex: &'a str,
    /// Present only for an ingest-authorized, operator-derived sweep.
    alias_tag: Option<&'a str>,
}

/// Returns a solver outcome after attempting any authorized alias publication.
async fn run_link_estimate(
    state: &Arc<crate::AppState>,
    store: &RedisJobStore,
    job_id: &str,
    keys: ResultKeys<'_>,
    body: LinkEstimateRequest,
) -> Outcome {
    let ResultKeys {
        payload_hash_hex,
        alias_tag,
    } = keys;
    // Kept out of `body` because the solve consumes it.
    let operator_focus = body.operator_focus.clone();
    let payload_hash = match u64::from_str_radix(payload_hash_hex, 16) {
        Ok(h) => Some(h),
        Err(e) => {
            // Hash is service-generated, so this indicates entry corruption —
            // log loudly and compute without S3 rather than serving nothing.
            tracing::error!(error = %e, payload_hash_hex,
                "unparseable entry input_hash — skipping S3 cache");
            None
        }
    };

    if let Some(hash) = payload_hash
        && let Some(s3) = &state.s3_cache
        && let Some(cached) = s3.load_link_estimate(hash).await
    {
        if cached.operator_focus == operator_focus {
            if let Some(tag) = alias_tag
                && !should_skip_publication(store, job_id).await
            {
                publish_result(
                    state,
                    job_id,
                    tag,
                    &operator_focus,
                    hash,
                    cache::PublicationSource::Persisted(&cached),
                )
                .await;
            }
            tracing::info!(job = %job_id, focus = %body.operator_focus, served_from = "s3",
                "link-estimate served from S3");
            return Outcome::Done(Box::new(
                // Plain structs of strings/floats — serialization cannot fail.
                serde_json::to_value(cached).expect("LinkEstimateResponse serializes to JSON"),
            ));
        }
        // A miss, not a failure: the fresh solve below overwrites the object.
        tracing::error!(job = %job_id, focus = %operator_focus, found = %cached.operator_focus,
            "persisted link estimate names another operator; recomputing");
    }

    let control = ComputeControl::default();
    let bridge = TaskGuard::spawn(bridge_control(
        store.clone(),
        job_id.to_string(),
        control.clone(),
    ));
    let _ = store.set_phase(job_id, "link-estimate").await;
    tracing::info!(job = %job_id, focus = %body.operator_focus, "link-estimate phase start");

    // Shared compute core (routes::run_link_estimate — the same one the sync
    // handler uses). The crate's cancellable variant primes the progress
    // denominator (`2^players` coalitions) and bumps the solved counters per
    // coalition, which the bridge flushes to Redis. A single coalition loop, so
    // it honours the warm-start one-compute-owns-the-pool contract.
    let start = std::time::Instant::now();
    let result =
        crate::routes::run_link_estimate(&body.input, &body.operator_focus, Some(control.clone()))
            .await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    bridge.stop().await;

    match result {
        Ok(resp) => {
            tracing::info!(job = %job_id, elapsed_ms, link_count = resp.links.len(),
                "link-estimate phase done");
            // The result is always persisted: epoch inputs are immutable, so it
            // never needs recomputing. Only the alias is gated on authority and
            // on the job not having been cancelled.
            if let (Some(hash), Some(s3)) = (payload_hash, &state.s3_cache) {
                let is_publishable =
                    alias_tag.is_some() && !should_skip_publication(store, job_id).await;
                match alias_tag {
                    Some(tag) if is_publishable => {
                        publish_result(
                            state,
                            job_id,
                            tag,
                            &operator_focus,
                            hash,
                            cache::PublicationSource::Unpersisted(&resp),
                        )
                        .await;
                    }
                    _ => s3.store_link_estimate(hash, &resp),
                }
            }
            Outcome::Done(Box::new(
                // Plain structs of strings/floats — serialization cannot fail.
                serde_json::to_value(resp).expect("LinkEstimateResponse serializes to JSON"),
            ))
        }
        // Cooperative cancel observed mid-solve → terminal cancelled.
        Err(LinkEstimateError::Cancelled) => Outcome::Cancelled,
        // Any other crate error is a deterministic function of the input.
        Err(LinkEstimateError::Engine(e)) => Outcome::Deterministic(e.to_string()),
        // spawn_blocking JoinError = a panic (e.g. OOM): possibly transient.
        Err(LinkEstimateError::Panicked) => {
            Outcome::Transient("link-estimate task panicked".to_string())
        }
    }
}

/// Where one operator of a sweep lands. Pure decision over the three inputs
/// (link count, S3-cached?, in-flight elsewhere?) so the bucketing is
/// exhaustively unit-testable; [`run_sweep`] gathers the inputs in
/// cheap-to-expensive order and only pays for an input when every earlier gate
/// passed (see the `false, false` / partial calls there).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SweepBucket {
    /// No focus-owned links — nothing to estimate.
    SkipNoLinks,
    /// Over the exact-solve player cap — would fail every time; never enqueue.
    SkipTooManyLinks,
    /// Result already persisted to S3 — done forever (epoch inputs immutable).
    Cached,
    /// An identical solve is already in flight (sweep child or UI job).
    AlreadyRunning,
    /// Needs a solve: create a child job and enqueue it.
    Enqueue,
}

fn sweep_bucket(links: usize, s3_cached: bool, inflight_elsewhere: bool) -> SweepBucket {
    if links == 0 {
        SweepBucket::SkipNoLinks
    } else if links > SWEEP_MAX_FOCUS_LINKS {
        SweepBucket::SkipTooManyLinks
    } else if s3_cached {
        SweepBucket::Cached
    } else if inflight_elsewhere {
        SweepBucket::AlreadyRunning
    } else {
        SweepBucket::Enqueue
    }
}

/// Expand a sweep into per-operator link-estimate children. Cheap-but-durable
/// work: every child shares the sweep's already-stored payload (one XADD each,
/// no payload writes), in-flight claims make redelivery idempotent (a crash
/// mid-expansion can never double-enqueue a child), and the terminal `done`
/// result IS the `{enqueued, cached, skipped, already_running, failed}`
/// summary the cron reads via `GET /jobs/{sweep_id}`.
///
/// Failure policy: a single child's failure is RECORDED and expansion
/// continues (a sweep must never half-die silently); only when every child
/// that reached the enqueue stage failed (Redis-wide outage) is the entry left
/// pending for the reclaim sweep to retry.
async fn run_sweep(
    state: &Arc<crate::AppState>,
    store: &RedisJobStore,
    job_id: &str,
    shared_payload_key: &str,
    payload: SweepPayload,
) -> Outcome {
    let alias_tag = payload.publish_tag();
    let mut enqueued: Vec<serde_json::Value> = Vec::new();
    let mut cached: Vec<String> = Vec::new();
    let mut skipped: Vec<serde_json::Value> = Vec::new();
    let mut already_running: Vec<serde_json::Value> = Vec::new();
    let mut failed: Vec<serde_json::Value> = Vec::new();
    let mut enqueue_attempts = 0usize;

    for op in &payload.operators {
        // Gate 1 — link counts (no I/O).
        let links = count_focus_links(&payload.input, op);
        match sweep_bucket(links, false, false) {
            SweepBucket::SkipNoLinks => {
                skipped.push(serde_json::json!({ "operator": op, "reason": "no links" }));
                continue;
            }
            SweepBucket::SkipTooManyLinks => {
                skipped.push(serde_json::json!({
                    "operator": op,
                    "reason": format!(
                        "{links} links exceeds the 20-player exact cap \
                         ({SWEEP_MAX_FOCUS_LINKS} max)"
                    ),
                }));
                continue;
            }
            _ => {}
        }

        let hash = link_estimate_payload_hash(&payload.input, op);
        let hash_hex = format!("{hash:016x}");

        // A cancel between operators ends the expansion. An unreadable flag is
        // an infrastructure failure, so the entry is left for a retry rather
        // than reported as a cancel nobody requested.
        match store.is_cancelled(job_id).await {
            Ok(true) => return Outcome::Cancelled,
            Ok(false) => {}
            Err(error) => {
                return Outcome::Transient(format!("cancel check failed: {error}"));
            }
        }

        // Gate 2 — completed work. A result already in S3, or one still in the
        // Redis result cache, is made durable and aliased here instead of being
        // solved again. A failed write is recorded so the marker stays absent
        // and the next sweep retries from the same cached result.
        if let Some(s3) = &state.s3_cache
            && let Some(found) = find_cached_estimate(store, s3, hash, &hash_hex, op).await
        {
            match reconcile_cached_estimate(s3, alias_tag, op, hash, &found).await {
                Ok(()) => cached.push(op.clone()),
                Err(error) => {
                    tracing::error!(%error, operator = %op, "alias publication failed");
                    failed.push(serde_json::json!({
                        "operator": op,
                        "error": "result or alias persistence failed",
                    }));
                }
            }
            continue;
        }

        // Gate 3 — in-flight dedup (live claim → attach; stale claim → clear).
        let inflight_elsewhere = match store.get_inflight(&hash_hex).await {
            Ok(Some(existing)) => {
                if matches!(store.snapshot(&existing).await, Ok(Some(_))) {
                    already_running.push(serde_json::json!({
                        "operator": op,
                        "job_id": existing,
                    }));
                    true
                } else {
                    let _ = store.clear_inflight(&hash_hex).await;
                    false
                }
            }
            Ok(None) => false,
            Err(e) => {
                // Dedup is an optimization — on Redis flake, fall through to
                // enqueue (worst case a duplicate solve, never a missed one).
                tracing::warn!(error = %e, operator = %op, "sweep: inflight lookup failed");
                false
            }
        };
        if sweep_bucket(links, false, inflight_elsewhere) != SweepBucket::Enqueue {
            continue;
        }

        // Enqueue a child: mint job → claim the hash for it → XADD (sharing
        // the sweep payload). Recorded per-child; never aborts the loop.
        enqueue_attempts += 1;
        let child_id = match store.create().await {
            Ok(id) => id,
            Err(e) => {
                tracing::error!(error = %e, operator = %op, "sweep: child create failed");
                failed.push(serde_json::json!({ "operator": op, "error": e.to_string() }));
                continue;
            }
        };
        match store.try_claim_inflight(&hash_hex, &child_id).await {
            Ok(true) => {}
            Err(e) => {
                // Fail-open: dedup is an optimization — enqueue anyway (worst
                // case a duplicate solve, never a missed one).
                tracing::warn!(error = %e, operator = %op, "sweep: inflight claim failed");
            }
            Ok(false) => {
                // Raced a concurrent identical submit between gate 3 and here.
                let _ = store
                    .set_failed(&child_id, "superseded: identical solve already in flight")
                    .await;
                let winner = store.get_inflight(&hash_hex).await.ok().flatten();
                already_running.push(serde_json::json!({ "operator": op, "job_id": winner }));
                continue;
            }
        }
        match store
            .enqueue_child(
                &child_id,
                JobKind::LinkEstimate,
                shared_payload_key,
                op,
                &hash_hex,
            )
            .await
        {
            Ok(()) => {
                tracing::info!(child_id, operator = %op, "sweep: link-estimate child enqueued");
                enqueued.push(serde_json::json!({ "operator": op, "job_id": child_id }));
            }
            Err(e) => {
                tracing::error!(error = %e, operator = %op, "sweep: child enqueue failed");
                let _ = store.clear_inflight(&hash_hex).await;
                let _ = store.set_failed(&child_id, "enqueue failed").await;
                failed.push(serde_json::json!({ "operator": op, "error": e.to_string() }));
            }
        }
    }

    // Every attempted enqueue failed and at least one was attempted ⇒ Redis is
    // gone, not a per-child fluke: leave the entry pending so the reclaim sweep
    // retries the whole expansion (idempotent via the claims above).
    if enqueue_attempts > 0 && enqueued.is_empty() && failed.len() == enqueue_attempts {
        return Outcome::Transient(format!(
            "all {enqueue_attempts} child enqueues failed — likely Redis outage"
        ));
    }

    // Every eligible operator must have a durable result and alias before this marker.
    let mut marker_written = false;
    if enqueued.is_empty()
        && already_running.is_empty()
        && failed.is_empty()
        && let Some(tag) = alias_tag
        && let Some(s3) = &state.s3_cache
    {
        marker_written = s3.store_sweep_marker(tag).await;
    }

    tracing::info!(
        job = %job_id,
        enqueued = enqueued.len(),
        cached = cached.len(),
        skipped = skipped.len(),
        already_running = already_running.len(),
        failed = failed.len(),
        marker_written,
        "sweep expansion done"
    );
    Outcome::Done(Box::new(serde_json::json!({
        "enqueued": enqueued,
        "cached": cached,
        "skipped": skipped,
        "already_running": already_running,
        "failed": failed,
        "marker_written": marker_written,
        "tag": payload.tag,
    })))
}

/// Baseline precompute as a queued job: cache short-circuit, else the same
/// `compute_and_store_baseline` the simulate path uses (memory + S3), with the
/// standard control/bridge so progress + cancellation work via `/jobs/{id}`.
async fn run_baseline(
    state: &Arc<crate::AppState>,
    store: &RedisJobStore,
    job_id: &str,
    input: ShapleyInputIn,
) -> Outcome {
    let input_hash = cache::hash_input(&input);
    if let Some(resp) = try_cached_baseline(state, input_hash).await {
        tracing::info!(job = %job_id, served_from = "cache", "baseline precompute already cached");
        return Outcome::Done(Box::new(
            // Plain structs of strings/floats — serialization cannot fail.
            serde_json::to_value(resp).expect("ShapleyResponse serializes to JSON"),
        ));
    }

    let control = ComputeControl::default();
    let bridge = TaskGuard::spawn(bridge_control(
        store.clone(),
        job_id.to_string(),
        control.clone(),
    ));
    let _ = store.set_phase(job_id, "baseline").await;
    tracing::info!(job = %job_id, "baseline precompute start");

    let start = std::time::Instant::now();
    let result = compute_and_store_baseline(state, &input, input_hash, Some(&control)).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    bridge.stop().await;

    match result {
        Ok(resp) => {
            tracing::info!(job = %job_id, elapsed_ms, "baseline precompute done");
            Outcome::Done(Box::new(
                serde_json::to_value(resp).expect("ShapleyResponse serializes to JSON"),
            ))
        }
        Err(e) => baseline_failure(e, &control),
    }
}

/// A failed baseline solve is `Cancelled` when the job's cancel flag was set,
/// since a cancel surfaces as an error string, and `Deterministic` otherwise.
fn baseline_failure(error: String, control: &ComputeControl) -> Outcome {
    if control.cancel.load(std::sync::atomic::Ordering::Relaxed) {
        Outcome::Cancelled
    } else {
        Outcome::Deterministic(format!("baseline: {error}"))
    }
}

/// Baseline publication: load the cached epoch or solve it, then persist the
/// result and write its alias. The result is always stored; only the alias is
/// gated on authority and cancellation. A failed alias write is reported in the
/// summary, not fatal: the next `POST /precompute/baseline` enqueues a retry
/// that takes the cached path and skips the solve.
async fn run_baseline_publish(
    state: &Arc<crate::AppState>,
    store: &RedisJobStore,
    job_id: &str,
    payload: BaselinePublishPayload,
) -> Outcome {
    let input_hash = cache::hash_input(&payload.input);
    let epoch = match load_cached_epoch(state, input_hash).await {
        Some(epoch) => {
            tracing::info!(job = %job_id, tag = %payload.tag, served_from = "cache", "baseline publish: result already cached");
            epoch
        }
        None => {
            let control = ComputeControl::default();
            let bridge = TaskGuard::spawn(bridge_control(
                store.clone(),
                job_id.to_string(),
                control.clone(),
            ));
            let _ = store.set_phase(job_id, "baseline").await;
            tracing::info!(job = %job_id, tag = %payload.tag, "baseline publish: solve start");
            let start = std::time::Instant::now();
            let result = compute_baseline(state, &payload.input, input_hash, Some(&control)).await;
            let elapsed_ms = start.elapsed().as_millis() as u64;
            bridge.stop().await;
            match result {
                Ok((epoch, _)) => {
                    tracing::info!(job = %job_id, elapsed_ms, "baseline publish: solve done");
                    epoch
                }
                Err(e) => return baseline_failure(e, &control),
            }
        }
    };

    let Some(baseline) = epoch.baseline_values.as_ref() else {
        return Outcome::Deterministic("baseline: epoch cache has no baseline".to_string());
    };
    let response = cache::response_from_baseline(baseline);
    let alias_written = publish_baseline_epoch(state, store, job_id, &payload, &epoch).await;
    Outcome::Done(Box::new(serde_json::json!({
        "input_hash": format!("{input_hash:016x}"),
        "tag": payload.tag,
        "variant": payload.variant,
        "alias_written": alias_written,
        "result": response,
    })))
}

/// Write the alias for a finished baseline when the job may publish. Returns
/// whether the alias landed. When it may not publish, the result is still
/// stored best-effort so the hash-keyed cache stays warm.
async fn publish_baseline_epoch(
    state: &crate::AppState,
    store: &RedisJobStore,
    job_id: &str,
    payload: &BaselinePublishPayload,
    epoch: &cache::EpochCache,
) -> bool {
    let Some(s3) = &state.s3_cache else {
        return false;
    };
    let Some(tag) = payload.publish_tag() else {
        tracing::warn!(job = %job_id, "baseline publish: payload is not authorized; storing without alias");
        s3.store(epoch).await;
        return false;
    };
    if should_skip_publication(store, job_id).await {
        s3.store(epoch).await;
        return false;
    }
    match s3.publish_baseline(tag, payload.variant, epoch).await {
        Ok(()) => true,
        Err(error) => {
            tracing::error!(%error, job = %job_id, tag, "baseline alias publication failed");
            false
        }
    }
}

/// Bridge loop: flush `ComputeControl.progress` into Redis and copy the Redis
/// cancel flag into `control.cancel`. Aborted when the solve finishes.
///
/// Each Redis call is bounded by [`OP_TIMEOUT`]: a stalled Redis (or an
/// exhausted pool) must never park this task — and the pooled connection it
/// would hold — indefinitely, which would cascade-stall every other pooled
/// caller (reclaim/ack/snapshot). On a timeout or error we just skip the tick;
/// the next one retries. Progress is best-effort by design.
async fn bridge_control(store: RedisJobStore, job_id: String, control: ComputeControl) {
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    const OP_TIMEOUT: Duration = Duration::from_secs(1);
    // Dev-log heartbeat cadence (~10s @ 250ms ticks). The UI/Redis bar updates
    // every tick; this is the coarse "still alive, here's where it's at" line for
    // devs tailing logs so a multi-minute solve never looks hung.
    const LOG_EVERY_TICKS: u32 = 40;
    let mut tick: u32 = 0;

    loop {
        match tokio::time::timeout(OP_TIMEOUT, store.is_cancelled(&job_id)).await {
            Ok(Ok(true)) => control.cancel.store(true, Ordering::Relaxed),
            Ok(Ok(false)) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "bridge: cancel check failed"),
            Err(_) => tracing::warn!("bridge: cancel check timed out"),
        }

        let p = &control.progress;
        let counters = crate::jobs::ProgressCounters {
            coalitions_solved: p.coalitions_solved.load(Ordering::Relaxed),
            samples_done: p.samples_done.load(Ordering::Relaxed),
            max_samples: p.max_samples.load(Ordering::Relaxed),
            batch_samples: p.batch_samples.load(Ordering::Relaxed),
            batch_total: p.batch_total.load(Ordering::Relaxed),
            batch_solved: p.batch_solved.load(Ordering::Relaxed),
        };
        match tokio::time::timeout(OP_TIMEOUT, store.set_progress(&job_id, counters)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "bridge: progress flush failed"),
            Err(_) => tracing::warn!("bridge: progress flush timed out"),
        }

        // Throttled dev heartbeat (skip until the denominator is primed). On the
        // per-city path `batch_solved`/`batch_total` are the coalition counts.
        if tick.is_multiple_of(LOG_EVERY_TICKS) && counters.batch_total > 0 {
            let percent = (counters.coalitions_solved.min(counters.batch_total) as f64
                / counters.batch_total as f64
                * 100.0) as u32;
            tracing::info!(
                job = %job_id,
                solved = counters.coalitions_solved,
                total = counters.batch_total,
                percent,
                "shapley solve progress"
            );
        }

        tick = tick.wrapping_add(1);

        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

struct TaskGuard(Option<tokio::task::JoinHandle<()>>);

impl TaskGuard {
    fn spawn(task: impl std::future::Future<Output = ()> + Send + 'static) -> Self {
        Self(Some(tokio::spawn(task)))
    }
    async fn stop(mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
            if let Err(error) = task.await
                && !error.is_cancelled()
            {
                tracing::error!(%error, "worker background task failed");
            }
        }
    }
}
impl Drop for TaskGuard {
    fn drop(&mut self) {
        if let Some(task) = &self.0 {
            task.abort();
        }
    }
}

fn claim_heartbeat(
    store: &RedisJobStore,
    consumer: &str,
    entry_id: &str,
    entry: &queue::StreamEntry,
) -> TaskGuard {
    let store = store.clone();
    let consumer = consumer.to_owned();
    let entry_id = entry_id.to_owned();
    let job_id = entry.job_id.clone();
    let shared_key =
        (entry.focus.is_some() || entry.kind == JobKind::Sweep).then(|| entry.payload_key.clone());
    TaskGuard::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let result = tokio::time::timeout(Duration::from_secs(1), async {
                touch_claim(&store, &entry_id, &consumer).await?;
                store.refresh_running_ttl(&job_id).await?;
                if let Some(key) = &shared_key {
                    store
                        .refresh_payload_ttl(key, queue::SWEEP_PAYLOAD_TTL_SECS)
                        .await?;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!(%error, job_id, "claim heartbeat failed"),
                Err(error) => tracing::warn!(%error, job_id, "claim heartbeat timed out"),
            }
        }
    })
}

/// Whether an alias write must be withheld. An unreadable cancel flag counts
/// as cancelled: the result itself is still stored, only its alias waits for
/// a later sweep.
async fn should_skip_publication(store: &RedisJobStore, job_id: &str) -> bool {
    match store.is_cancelled(job_id).await {
        Ok(is_cancelled) => is_cancelled,
        Err(error) => {
            tracing::warn!(%error, job_id, "cancellation check failed; withholding publication");
            true
        }
    }
}

async fn publish_result(
    state: &crate::AppState,
    job_id: &str,
    tag: &str,
    focus: &str,
    hash: u64,
    source: crate::cache::PublicationSource<'_>,
) {
    if let Some(s3) = &state.s3_cache
        && let Err(error) = s3.publish_link_estimate(tag, focus, hash, source).await
    {
        tracing::error!(%error, job_id, tag, focus, "alias publication failed");
    }
}

/// Whether a cached response can complete `entry` without a solve. A link
/// estimate must parse and name this entry's operator; when it does and the
/// sweep is authorized, its alias is published here, because this is the only
/// moment the result is known to exist. Other kinds are republished as stored.
async fn reconcile_cached_result(
    state: &Arc<crate::AppState>,
    store: &RedisJobStore,
    entry: &queue::StreamEntry,
    alias_tag: Option<&str>,
    resp: &serde_json::Value,
) -> anyhow::Result<bool> {
    if entry.kind != JobKind::LinkEstimate {
        return Ok(true);
    }
    let Some(estimate) = cached_link_estimate(entry, resp) else {
        tracing::warn!(job_id = %entry.job_id, "invalid cached link estimate; recomputing");
        return Ok(false);
    };
    if let (Some(tag), Some(focus), Ok(hash)) = (
        alias_tag,
        entry.focus.as_deref(),
        u64::from_str_radix(&entry.input_hash, 16),
    ) && !store.is_cancelled(&entry.job_id).await?
    {
        publish_result(
            state,
            &entry.job_id,
            tag,
            focus,
            hash,
            cache::PublicationSource::Unpersisted(&estimate),
        )
        .await;
    }
    Ok(true)
}

/// The cached JSON as a link estimate for this entry's operator, or `None`
/// when it does not parse or names another operator.
fn cached_link_estimate(
    entry: &queue::StreamEntry,
    resp: &serde_json::Value,
) -> Option<LinkEstimateResponse> {
    let estimate = serde_json::from_value::<LinkEstimateResponse>(resp.clone()).ok()?;
    let is_own_operator = entry
        .focus
        .as_ref()
        .is_none_or(|focus| estimate.operator_focus == *focus);
    is_own_operator.then_some(estimate)
}

/// A finished link estimate found outside the solver, and where it lives.
enum CachedEstimate {
    /// Durable in S3; at most the alias is missing.
    Persisted(LinkEstimateResponse),
    /// Only in the one-hour Redis result cache; must be persisted before an
    /// alias may point at it.
    RedisOnly(LinkEstimateResponse),
}

/// Looks for a finished estimate for `op` in S3, then in the Redis result
/// cache. A result naming another operator counts as absent, so the sweep
/// enqueues a solve whose result overwrites it.
async fn find_cached_estimate(
    store: &RedisJobStore,
    s3: &cache::S3Cache,
    hash: u64,
    hash_hex: &str,
    op: &str,
) -> Option<CachedEstimate> {
    if let Some(result) = s3.load_link_estimate(hash).await {
        if result.operator_focus == op {
            return Some(CachedEstimate::Persisted(result));
        }
        tracing::error!(operator = %op, found = %result.operator_focus,
            "persisted link estimate names another operator; recomputing");
        return None;
    }
    match store.result_cache_get(hash_hex).await {
        Ok(Some(value)) => match serde_json::from_value::<LinkEstimateResponse>(value) {
            Ok(result) if result.operator_focus == op => Some(CachedEstimate::RedisOnly(result)),
            _ => {
                tracing::warn!(operator = %op, "invalid cached link estimate; recomputing");
                None
            }
        },
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, operator = %op, "Redis result lookup failed");
            None
        }
    }
}

/// Makes a found estimate durable and, for an authorized sweep, publishes its
/// alias. A persisted result without a tag needs nothing.
async fn reconcile_cached_estimate(
    s3: &cache::S3Cache,
    alias_tag: Option<&str>,
    op: &str,
    hash: u64,
    found: &CachedEstimate,
) -> anyhow::Result<()> {
    match (found, alias_tag) {
        (CachedEstimate::Persisted(result), Some(tag)) => {
            s3.publish_link_estimate(tag, op, hash, cache::PublicationSource::Persisted(result))
                .await
        }
        (CachedEstimate::RedisOnly(result), Some(tag)) => {
            s3.publish_link_estimate(tag, op, hash, cache::PublicationSource::Unpersisted(result))
                .await
        }
        (CachedEstimate::RedisOnly(result), None) => s3.persist_link_estimate(hash, result).await,
        (CachedEstimate::Persisted(_), None) => Ok(()),
    }
}

/// Claim-heartbeat: re-`XCLAIM` our own in-flight entry (min-idle 0, `JUSTID`)
/// to reset its pending-list idle time. Without this, a multi-minute solve
/// leaves the entry "idle" in the PEL and the other worker's reclaim sweep
/// (min-idle [`queue::RECLAIM_MIN_IDLE_MS`]) double-processes it. `JUSTID` does
/// NOT increment the delivery counter, so heartbeating can never poison the
/// entry. Best-effort: a failed beat just means the next one retries.
async fn touch_claim(store: &RedisJobStore, entry_id: &str, consumer: &str) -> anyhow::Result<()> {
    let mut conn = store.pool().get().await?;
    // min-idle-time 0: we already own it; this just resets last-delivery time.
    let _: Vec<String> = redis::cmd("XCLAIM")
        .arg(queue::STREAM_KEY)
        .arg(queue::CONSUMER_GROUP)
        .arg(consumer)
        .arg(0)
        .arg(entry_id)
        .arg("JUSTID")
        .query_async(&mut conn)
        .await?;
    Ok(())
}

/// Crash-recovery sweep: `XAUTOCLAIM` entries idle longer than
/// [`queue::RECLAIM_MIN_IDLE_MS`] (left pending by a dead worker), then either
/// dead-letter them (delivery count exceeded) or reprocess them inline. No
/// `JUSTID`, so the full field map comes back and the delivery counter advances.
async fn reclaim(
    state: &Arc<crate::AppState>,
    store: &RedisJobStore,
    consumer: &str,
) -> anyhow::Result<()> {
    let opts = StreamAutoClaimOptions::default().count(10);
    let reply: StreamAutoClaimReply = {
        let mut conn = store.pool().get().await?;
        conn.xautoclaim_options(
            queue::STREAM_KEY,
            queue::CONSUMER_GROUP,
            consumer,
            queue::RECLAIM_MIN_IDLE_MS,
            "0-0",
            opts,
        )
        .await?
    };

    for entry in &reply.claimed {
        if entry.map.is_empty() {
            // Tombstone (entry trimmed/deleted from the stream) — drop it.
            ack(store, &entry.id).await?;
            continue;
        }
        // Parse up front so the redelivery cap can be kind-aware (LinkEstimate
        // dead-letters sooner — see `MAX_DELIVERIES_LINK_ESTIMATE`).
        let parsed = queue::StreamEntry::from_field_map(&entry.map).ok();
        let max_deliveries = match parsed.as_ref().map(|e| e.kind) {
            Some(JobKind::LinkEstimate) => queue::MAX_DELIVERIES_LINK_ESTIMATE,
            _ => queue::MAX_DELIVERIES,
        };
        if delivery_count(store, &entry.id).await? > max_deliveries {
            let job_id = parsed
                .as_ref()
                .map(|e| e.job_id.clone())
                .unwrap_or_else(|| "unknown".to_string());
            tracing::error!(job_id, entry_id = %entry.id, "poison entry (max deliveries) → dead-letter");
            let _ = store.set_failed(&job_id, "exceeded max deliveries").await;
            // A dead-lettered link-estimate must release its dedup claim, or
            // every resubmit for up to INFLIGHT_TTL_SECS attaches to this
            // permanently-failed job instead of recomputing.
            if let Some(e) = &parsed {
                clear_inflight_for(store, e).await;
            }
            dead_letter(store, &job_id, &entry.id, "max-deliveries").await?;
            ack(store, &entry.id).await?;
        } else {
            tracing::info!(entry_id = %entry.id, "reclaimed abandoned entry — reprocessing");
            process_entry(state, store, consumer, &entry.id, &entry.map).await?;
        }
    }
    Ok(())
}

/// How many times the consumer group has delivered `entry_id` (from `XPENDING`).
async fn delivery_count(store: &RedisJobStore, entry_id: &str) -> anyhow::Result<usize> {
    let mut conn = store.pool().get().await?;
    let pending: StreamPendingCountReply = conn
        .xpending_count(
            queue::STREAM_KEY,
            queue::CONSUMER_GROUP,
            entry_id,
            entry_id,
            1usize,
        )
        .await?;
    Ok(pending.ids.first().map(|p| p.times_delivered).unwrap_or(0))
}

/// `XACK` an entry off the work Stream's pending list.
async fn ack(store: &RedisJobStore, entry_id: &str) -> anyhow::Result<()> {
    let mut conn = store.pool().get().await?;
    let _: usize = conn
        .xack(queue::STREAM_KEY, queue::CONSUMER_GROUP, &[entry_id])
        .await?;
    Ok(())
}

/// Move a poison entry to the dead-letter Stream (alert-and-drop; retained for
/// inspection). The work-Stream entry must still be `XACK`'d by the caller.
async fn dead_letter(
    store: &RedisJobStore,
    job_id: &str,
    src_id: &str,
    reason: &str,
) -> anyhow::Result<()> {
    let mut conn = store.pool().get().await?;
    let _: String = redis::cmd("XADD")
        .arg(queue::DEAD_LETTER_KEY)
        .arg("MAXLEN")
        .arg("~")
        .arg(queue::STREAM_MAXLEN)
        .arg("*")
        .arg("job_id")
        .arg(job_id)
        .arg("src_id")
        .arg(src_id)
        .arg("reason")
        .arg(reason)
        .query_async(&mut conn)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{SweepBucket, sweep_bucket};
    use crate::routes::SWEEP_MAX_FOCUS_LINKS;

    /// Exhaustive bucketing: priority is links → cached → in-flight → enqueue,
    /// and a link-count skip wins regardless of the other inputs.
    #[test]
    fn bucketing_is_exhaustive_and_prioritized() {
        for &s3_cached in &[false, true] {
            for &inflight in &[false, true] {
                // 0 links always skips, whatever the other inputs claim.
                assert_eq!(
                    sweep_bucket(0, s3_cached, inflight),
                    SweepBucket::SkipNoLinks
                );
                // Over the exact cap always skips too.
                assert_eq!(
                    sweep_bucket(SWEEP_MAX_FOCUS_LINKS + 1, s3_cached, inflight),
                    SweepBucket::SkipTooManyLinks
                );
            }
        }
        // In range: cached beats in-flight beats enqueue.
        for links in [1, 2, SWEEP_MAX_FOCUS_LINKS] {
            assert_eq!(sweep_bucket(links, true, false), SweepBucket::Cached);
            assert_eq!(sweep_bucket(links, true, true), SweepBucket::Cached);
            assert_eq!(
                sweep_bucket(links, false, true),
                SweepBucket::AlreadyRunning
            );
            assert_eq!(sweep_bucket(links, false, false), SweepBucket::Enqueue);
        }
    }

    /// The cap boundary is inclusive: exactly SWEEP_MAX_FOCUS_LINKS still
    /// enqueues (players = links + "Others" = 20, the engine's exact limit).
    #[test]
    fn cap_boundary_is_inclusive() {
        assert_eq!(
            sweep_bucket(SWEEP_MAX_FOCUS_LINKS, false, false),
            SweepBucket::Enqueue
        );
        assert_eq!(
            sweep_bucket(SWEEP_MAX_FOCUS_LINKS + 1, false, false),
            SweepBucket::SkipTooManyLinks
        );
    }
}
