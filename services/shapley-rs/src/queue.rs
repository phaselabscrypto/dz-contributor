//! Shared Redis keyspace + Stream-entry contract for the async compute queue
//! (ADR 0001, Phase 2). This module is the *single source of truth* for every
//! Redis key name, the consumer-group name, the stream caps/timeouts, and the
//! shape of a queue entry — reused verbatim by both the `api` and `worker`
//! roles of the one-binary split so they can never drift apart.
//!
//! Nothing here touches Redis itself; it only defines names and the
//! (de)serialization of a Stream entry. The actual `XADD`/`XREADGROUP`/
//! `XACK`/`XAUTOCLAIM` calls live in the api/worker code that imports these.
//!
//! Keyspace (verbatim from ADR 0001 "Redis keyspace", plus the sweep additions):
//! ```text
//! shapley:whatif:stream            STREAM  capped (XADD MAXLEN ~ 10000); group whatif-workers
//! shapley:whatif:dead              STREAM  dead-letter (delivery-count > 3)
//! shapley:whatif:payload:{job_id}  STRING  serde-JSON request; TTL 3600s (store-and-reference);
//!                                           a SWEEP's payload is shared by its children and gets
//!                                           SWEEP_PAYLOAD_TTL_SECS (24h), refreshed on child pickup
//! shapley:whatif:result:{hash}     STRING  serialized SimulateResponse; TTL ~3600s (idempotency cache)
//! shapley:whatif:state:{job_id}    HASH    {state, coalitions_solved, samples_done, max_samples,
//!                                           percent, result_ref?, error?, heartbeat_at}; EXPIRE
//!                                           JOB_TTL_SECS while running (heartbeat-refreshed),
//!                                           TERMINAL_TTL_SECS once done/failed/cancelled
//! shapley:whatif:cancel:{job_id}   STRING  "1"; TTL JOB_TTL_SECS (separate key — cancel-race note)
//! shapley:linkest:inflight:{hash}  STRING  job_id; SET NX EX INFLIGHT_TTL_SECS (in-flight dedup —
//!                                           cleared by the worker on terminal states)
//! ```
//!
//! Entry schemas: `whatif/v1` (simulate), `linkest/v1` (link-estimate; optional
//! additive `focus` field — absent means self-contained payload), `sweep/v1`
//! (sweep expansion), `baseline/v1` (baseline precompute).

use std::collections::HashMap;

// ── Stream + consumer group ──────────────────────────────────────────────

/// The work queue Stream. Capped with `XADD ... MAXLEN ~ STREAM_MAXLEN`.
pub const STREAM_KEY: &str = "shapley:whatif:stream";

/// Dead-letter Stream for poison-pill entries (delivery-count > MAX_DELIVERIES).
pub const DEAD_LETTER_KEY: &str = "shapley:whatif:dead";

/// Consumer group name. Created once via `XGROUP CREATE ... $ MKSTREAM`
/// (BUSYGROUP on re-create is expected and ignored — see ADR queue mechanics).
pub const CONSUMER_GROUP: &str = "whatif-workers";

/// Approximate cap for the work Stream (`MAXLEN ~ 10000`). Entries are tiny
/// (refs only), so this is a generous backlog bound, not a memory concern.
pub const STREAM_MAXLEN: usize = 10_000;

/// `XREADGROUP ... BLOCK` long-poll, milliseconds. One job at a time
/// (`COUNT 1`); the block lets a worker park cheaply with no backlog.
pub const READ_BLOCK_MS: usize = 5_000;

/// `XREADGROUP ... COUNT` — one job per read so a single slow solve can't
/// hoard a batch it won't finish before the reclaim window.
pub const READ_COUNT: usize = 1;

/// Reclaim sweep cadence and `XAUTOCLAIM` min-idle-time, milliseconds. Aligned
/// to the worker `terminationGracePeriodSeconds` and comfortably above a
/// `for_simulation` solve, so only *dead*-pod entries cross it.
pub const RECLAIM_MIN_IDLE_MS: usize = 30_000;

/// Poison-pill guard: an entry redelivered more than this many times (read
/// from `XPENDING` `times_delivered`) is moved to the dead-letter Stream and
/// `XACK`'d off the work Stream.
pub const MAX_DELIVERIES: usize = 3;

/// Tighter redelivery cap for `LinkEstimate`: an OOM SIGKILL is uncatchable, so
/// the entry is reclaimed and re-OOMs each worker it lands on. Dead-lettering
/// after one retry stops an oversized breakdown crash-looping the whole pool.
pub const MAX_DELIVERIES_LINK_ESTIMATE: usize = 1;

// ── Per-job key TTLs ─────────────────────────────────────────────────────

/// TTL (seconds) for the payload String — covers a job's whole lifetime with
/// generous slack for at-least-once redelivery; the result cache outlives it.
pub const PAYLOAD_TTL_SECS: u64 = 3_600;

/// TTL (seconds) for a SWEEP's shared payload String. A sweep's last child can
/// sit behind hours of solves on the fixed worker pool, so the 1h per-job TTL
/// would expire the payload before pickup (→ spurious dead-letters). 24h, plus
/// the worker refreshes it (EXPIRE) every time it picks up a child, so a deep
/// queue can never out-wait the payload.
pub const SWEEP_PAYLOAD_TTL_SECS: u64 = 86_400;

/// TTL (seconds) for the in-flight dedup key (`inflight_key`). A backstop only —
/// the worker clears the key on terminal states; expiry exists so a stuck key
/// can delay but never permanently block recompute. Matches the sweep payload
/// TTL (≥ worst-case queue wait + solve).
pub const INFLIGHT_TTL_SECS: u64 = 86_400;

/// TTL (seconds) for the `result:{hash}` idempotency cache.
pub const RESULT_TTL_SECS: u64 = 3_600;

/// Whole-key EXPIRE (seconds) for a RUNNING `state:{job_id}` hash and the
/// `cancel:{job_id}` flag. Refreshed on every progress/phase heartbeat
/// (`jobs.rs`), so this must only outlast the worst-case QUEUE wait before a
/// worker first heartbeats — 600s was too low for a busy fixed pool (a job
/// queued behind ~15-min solves expired before pickup). Terminal states get
/// [`TERMINAL_TTL_SECS`] instead; `jobs.rs` derives its `i64` view from this
/// constant (not a hand-synced duplicate) so the two can never drift.
pub const JOB_TTL_SECS: u64 = 1_800;

/// Whole-key EXPIRE (seconds) for a TERMINAL `state:{job_id}` hash
/// (done/failed/cancelled). A running hash lives [`JOB_TTL_SECS`],
/// heartbeat-refreshed; once terminal it is no longer refreshed, so this is the
/// window a finished result stays pollable by job id — 24h so a user can come
/// back the next day (PSYS-557). Durable retrieval beyond that is the S3 result
/// store (`cache::S3Cache::load_simulate`), keyed by the request hash.
pub const TERMINAL_TTL_SECS: u64 = 86_400;

// ── Schema tags ──────────────────────────────────────────────────────────

/// Schema version stamped onto simulate (what-if) Stream entries. A worker that
/// reads an entry whose `schema` it doesn't recognize dead-letters it rather
/// than mis-decoding a payload from a newer/older producer. Bump on any
/// breaking change to the payload String shape or the entry field set.
pub const ENTRY_SCHEMA: &str = "whatif/v1";

/// Schema version stamped onto link-estimate Stream entries. A DISTINCT tag
/// (not a `kind` piggybacking on `whatif/v1`) so that a worker whose binary
/// doesn't know this kind (e.g. during a mixed-version rollout) dead-letters
/// the entry immediately with the accurate "unsupported job schema" failure —
/// instead of burning MAX_DELIVERIES blind retries on a payload it
/// deserializes as the wrong type and then failing the job with a misleading
/// "exceeded max deliveries".
pub const LINKEST_SCHEMA: &str = "linkest/v1";

/// Schema version stamped onto sweep Stream entries (the epoch-cron expansion
/// job: payload is a `SweepPayload`, the worker fans it out into per-operator
/// link-estimate children). Own tag per the [`LINKEST_SCHEMA`] mixed-version
/// rule: an older worker dead-letters it instead of mis-decoding.
pub const SWEEP_SCHEMA: &str = "sweep/v1";

/// Schema version stamped onto baseline-precompute Stream entries (payload is
/// a self-contained `ShapleyInputIn`; the worker runs
/// `compute_and_store_baseline`). Own tag per the [`LINKEST_SCHEMA`] rule.
pub const BASELINE_SCHEMA: &str = "baseline/v1";

// ── Key builders (the only place `{job_id}` / `{hash}` are interpolated) ──

/// `shapley:whatif:payload:{job_id}` — TTL'd String holding the JSON
/// `SimulateRequest` (store-and-reference; never inlined into the Stream).
pub fn payload_key(job_id: &str) -> String {
    format!("shapley:whatif:payload:{job_id}")
}

/// `shapley:whatif:result:{hash}` — idempotency cache keyed by the WHOLE
/// what-if request hash (hex) from [`hash_payload`]; no separate dedup table.
pub fn result_key(input_hash_hex: &str) -> String {
    format!("shapley:whatif:result:{input_hash_hex}")
}

/// Idempotency hash of a what-if request's canonical JSON payload — the exact
/// string stored under `payload:{job_id}`. Keyed on the WHOLE request
/// (baseline **and** modified together determine the result), so `result:{hash}`
/// can never alias two requests that share only one topology. Uses the same
/// `DefaultHasher` style as `cache::hash_input`, but is deliberately distinct
/// from the S3 baseline key (`cache::hash_input(&baseline)`) — conflating them
/// would cross-contaminate two different caches. Fail-safe by construction:
/// identical bytes → identical key, and the caller serializes once and handles
/// serialization errors *before* calling this (so there is no silent fallback).
pub fn hash_payload(payload_json: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    payload_json.hash(&mut h);
    h.finish()
}

/// `shapley:whatif:state:{job_id}` — the job-state HASH. Identical to
/// `jobs.rs::state_key` so api + worker + Phase 1 all address the same hash.
pub fn state_key(job_id: &str) -> String {
    format!("shapley:whatif:state:{job_id}")
}

/// `shapley:whatif:cancel:{job_id}` — the separate cancel flag. A progress
/// flush must never write `state` (would clobber a concurrent cancel — ADR C4),
/// so cancellation lives in its own key that the bridge task polls.
pub fn cancel_key(job_id: &str) -> String {
    format!("shapley:whatif:cancel:{job_id}")
}

/// `shapley:linkest:inflight:{hash}` — in-flight dedup claim for a
/// link-estimate input hash (hex from `link_estimate_payload_hash`). Holds the
/// claiming job_id; written `SET NX EX INFLIGHT_TTL_SECS`, cleared by the
/// worker on terminal states. The S3 result cache dedups *completed* work;
/// this covers the in-flight window so the sweep and the UI can never run the
/// same multi-minute solve twice.
pub fn inflight_key(input_hash_hex: &str) -> String {
    format!("shapley:linkest:inflight:{input_hash_hex}")
}

// ── Stream entry ─────────────────────────────────────────────────────────

/// Field names of a Stream entry. Centralized so the producer's `XADD` arg
/// order and the consumer's map lookups can never disagree on spelling.
pub mod field {
    pub const JOB_ID: &str = "job_id";
    pub const PAYLOAD_KEY: &str = "payload_key";
    pub const INPUT_HASH: &str = "input_hash";
    pub const ENQUEUED_AT: &str = "enqueued_at";
    pub const SCHEMA: &str = "schema";
    /// Job-type discriminator (see [`super::JobKind`]). Optional on the wire — a
    /// missing `kind` decodes as `Simulate`, so entries written before this field
    /// existed still parse without a schema bump.
    pub const KIND: &str = "kind";
    /// Operator focus for a sweep-spawned link-estimate child. Optional on the
    /// wire — absent means the payload is a self-contained `LinkEstimateRequest`
    /// (the pre-sweep shape); present means `payload_key` points at the parent
    /// sweep's SHARED payload and the worker builds the request from it + focus.
    pub const FOCUS: &str = "focus";
}

/// Which compute a queue entry drives — selects how the worker deserializes the
/// `payload:{job_id}` String and which solve to run. Serialized as the `kind`
/// stream-entry field; a missing/unknown value decodes as [`JobKind::Simulate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobKind {
    /// What-if: payload is a `SimulateRequest`; runs the per-city reward solve.
    Simulate,
    /// Per-link value-add: payload is a `LinkEstimateRequest`; runs the faithful
    /// `network_link_estimate` (retag-Shapley).
    LinkEstimate,
    /// Epoch sweep expansion: payload is a `SweepPayload`; the worker fans it
    /// out into per-operator link-estimate children sharing the sweep payload.
    Sweep,
    /// Baseline precompute: payload is a self-contained `ShapleyInputIn`; the
    /// worker runs `compute_and_store_baseline` (memory + S3).
    Baseline,
}

impl JobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            JobKind::Simulate => "simulate",
            JobKind::LinkEstimate => "link-estimate",
            JobKind::Sweep => "sweep",
            JobKind::Baseline => "baseline",
        }
    }

    /// Parse the wire value. Anything unrecognized (including absent) is
    /// `Simulate` — safe because a FUTURE kind must also carry its own schema
    /// tag (see [`LINKEST_SCHEMA`]), which this binary would dead-letter before
    /// ever consulting `kind`.
    pub fn from_wire(s: &str) -> Self {
        match s {
            "link-estimate" => JobKind::LinkEstimate,
            "sweep" => JobKind::Sweep,
            "baseline" => JobKind::Baseline,
            _ => JobKind::Simulate,
        }
    }

    /// The entry schema tag stamped for this kind (the mixed-version gate).
    pub fn schema(self) -> &'static str {
        match self {
            JobKind::Simulate => ENTRY_SCHEMA,
            JobKind::LinkEstimate => LINKEST_SCHEMA,
            JobKind::Sweep => SWEEP_SCHEMA,
            JobKind::Baseline => BASELINE_SCHEMA,
        }
    }
}

/// A queue entry — deliberately *tiny* (refs only). The heavy `SimulateRequest`
/// lives in the TTL'd `payload:{job_id}` String, NOT inline: Streams live fully
/// in RAM and unacked entries linger in the PEL, so inlining MBs would bloat
/// memory and every reclaim scan (ADR "Stream entries stay tiny").
///
/// Exactly the five ADR fields: `{job_id, payload_key, input_hash, enqueued_at,
/// schema}`. Serialized as flat field/value string pairs for `XADD`, and parsed
/// back from the `map: HashMap<String, redis::Value>` of a `StreamId`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamEntry {
    /// UUIDv4 minted by the API pod (not Redis `INCR`) so the producer returns
    /// `202` with no extra round-trip.
    pub job_id: String,
    /// Key of the payload String: `shapley:whatif:payload:{job_id}`.
    pub payload_key: String,
    /// Topology hash (hex) from `cache::hash_input`; drives the idempotency
    /// check against `result:{input_hash}` before the worker computes.
    pub input_hash: String,
    /// Producer enqueue time, Unix epoch milliseconds (observability / lag).
    pub enqueued_at: u64,
    /// Entry schema tag; see [`ENTRY_SCHEMA`]. Unknown → dead-letter.
    pub schema: String,
    /// Which compute + payload shape this entry is (see [`JobKind`]).
    pub kind: JobKind,
    /// Operator focus for sweep-spawned link-estimate children (see
    /// [`field::FOCUS`]). `None` ⇒ self-contained payload (legacy shape).
    pub focus: Option<String>,
}

impl StreamEntry {
    /// Build an entry from a freshly-minted job. `payload_key` is derived from
    /// `job_id`, `schema` is stamped per-kind ([`JobKind::schema`]), and
    /// `enqueued_at` is captured as "now".
    pub fn new(job_id: String, kind: JobKind, input_hash: String, enqueued_at_ms: u64) -> Self {
        let payload_key = payload_key(&job_id);
        Self {
            job_id,
            payload_key,
            input_hash,
            enqueued_at: enqueued_at_ms,
            schema: kind.schema().to_string(),
            kind,
            focus: None,
        }
    }

    /// Build a sweep CHILD entry: `payload_key` points at the parent sweep's
    /// shared payload (NOT derived from this child's `job_id`), and `focus`
    /// names the operator the worker should solve from that shared input.
    pub fn new_child(
        job_id: String,
        kind: JobKind,
        shared_payload_key: String,
        focus: String,
        input_hash: String,
        enqueued_at_ms: u64,
    ) -> Self {
        Self {
            job_id,
            payload_key: shared_payload_key,
            input_hash,
            enqueued_at: enqueued_at_ms,
            schema: kind.schema().to_string(),
            kind,
            focus: Some(focus),
        }
    }

    /// Flat `(field, value)` pairs for `XADD ... <id> field value ...`. Order
    /// is fixed and matches the ADR field list; the optional `focus` field is
    /// emitted only when present (absent ⇒ legacy self-contained payload).
    pub fn to_field_pairs(&self) -> Vec<(&'static str, String)> {
        let mut pairs = vec![
            (field::JOB_ID, self.job_id.clone()),
            (field::PAYLOAD_KEY, self.payload_key.clone()),
            (field::INPUT_HASH, self.input_hash.clone()),
            (field::ENQUEUED_AT, self.enqueued_at.to_string()),
            (field::SCHEMA, self.schema.clone()),
            (field::KIND, self.kind.as_str().to_string()),
        ];
        if let Some(focus) = &self.focus {
            pairs.push((field::FOCUS, focus.clone()));
        }
        pairs
    }

    /// Parse an entry out of a consumed `StreamId.map`. The values come back as
    /// `redis::Value` (bulk strings); we decode each via `from_redis_value`.
    /// Returns `Err` if any required field is missing or undecodable so the
    /// worker can dead-letter a malformed entry rather than panic.
    pub fn from_field_map(
        map: &HashMap<String, deadpool_redis::redis::Value>,
    ) -> anyhow::Result<Self> {
        use deadpool_redis::redis::from_redis_value;

        fn get_str(
            map: &HashMap<String, deadpool_redis::redis::Value>,
            field: &str,
        ) -> anyhow::Result<String> {
            let v = map
                .get(field)
                .ok_or_else(|| anyhow::anyhow!("stream entry missing field `{field}`"))?;
            Ok(from_redis_value(v)?)
        }

        let enqueued_at = get_str(map, field::ENQUEUED_AT)?
            .parse::<u64>()
            .map_err(|e| anyhow::anyhow!("invalid `{}`: {e}", field::ENQUEUED_AT))?;

        // `kind` is optional: an entry without the field decodes as Simulate.
        let kind = map
            .get(field::KIND)
            .and_then(|v| deadpool_redis::redis::from_redis_value::<String>(v).ok())
            .map(|s| JobKind::from_wire(&s))
            .unwrap_or(JobKind::Simulate);

        // `focus` is optional: absent ⇒ self-contained payload (legacy shape).
        let focus = map
            .get(field::FOCUS)
            .and_then(|v| deadpool_redis::redis::from_redis_value::<String>(v).ok());

        Ok(Self {
            job_id: get_str(map, field::JOB_ID)?,
            payload_key: get_str(map, field::PAYLOAD_KEY)?,
            input_hash: get_str(map, field::INPUT_HASH)?,
            enqueued_at,
            schema: get_str(map, field::SCHEMA)?,
            kind,
            focus,
        })
    }

    /// Whether this entry's schema is one the running binary understands.
    /// Unknown schema → the worker dead-letters without decoding the payload.
    pub fn schema_supported(&self) -> bool {
        self.schema == ENTRY_SCHEMA
            || self.schema == LINKEST_SCHEMA
            || self.schema == SWEEP_SCHEMA
            || self.schema == BASELINE_SCHEMA
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_builders_match_adr_keyspace() {
        assert_eq!(payload_key("abc"), "shapley:whatif:payload:abc");
        assert_eq!(result_key("deadbeef"), "shapley:whatif:result:deadbeef");
        assert_eq!(state_key("abc"), "shapley:whatif:state:abc");
        assert_eq!(cancel_key("abc"), "shapley:whatif:cancel:abc");
    }

    #[test]
    fn state_key_matches_phase1_jobs_format() {
        // Must equal jobs.rs::state_key / cancel_key so Phase 1 + Phase 2
        // address the same hash/flag.
        assert_eq!(state_key("u"), format!("shapley:whatif:state:{}", "u"));
        assert_eq!(cancel_key("u"), format!("shapley:whatif:cancel:{}", "u"));
    }

    fn map_of(entry: &StreamEntry) -> HashMap<String, deadpool_redis::redis::Value> {
        use deadpool_redis::redis::Value;
        entry
            .to_field_pairs()
            .into_iter()
            .map(|(k, v)| (k.to_string(), Value::BulkString(v.into_bytes())))
            .collect()
    }

    #[test]
    fn entry_roundtrips_through_field_map() {
        let entry = StreamEntry::new(
            "job-1".into(),
            JobKind::LinkEstimate,
            "00ff".into(),
            1_725_000_000_123,
        );
        assert_eq!(entry.payload_key, "shapley:whatif:payload:job-1");
        // Link-estimate entries carry their OWN schema tag so workers that don't
        // know the kind dead-letter them instead of mis-decoding the payload.
        assert_eq!(entry.schema, LINKEST_SCHEMA);

        // Simulate a consumed StreamId.map (Redis returns bulk strings).
        let parsed = StreamEntry::from_field_map(&map_of(&entry)).expect("parse");
        assert_eq!(parsed, entry);
        assert_eq!(parsed.kind, JobKind::LinkEstimate);
        assert!(parsed.schema_supported());
    }

    #[test]
    fn schema_is_stamped_per_kind_and_junk_is_unsupported() {
        let sim = StreamEntry::new("a".into(), JobKind::Simulate, "00".into(), 1);
        assert_eq!(sim.schema, ENTRY_SCHEMA);
        assert!(sim.schema_supported());

        let mut unknown = StreamEntry::new("b".into(), JobKind::Simulate, "00".into(), 1);
        unknown.schema = "whatif/v9".to_string();
        assert!(!unknown.schema_supported());
    }

    #[test]
    fn missing_kind_defaults_to_simulate() {
        // Entries without a `kind` field still parse, as simulate jobs.
        let entry = StreamEntry::new("job-2".into(), JobKind::Simulate, "00ff".into(), 1);
        let mut map = map_of(&entry);
        map.remove(field::KIND);
        let parsed = StreamEntry::from_field_map(&map).expect("parse");
        assert_eq!(parsed.kind, JobKind::Simulate);
    }

    #[test]
    fn missing_field_is_an_error_not_a_panic() {
        use deadpool_redis::redis::Value;
        let mut map: HashMap<String, Value> = HashMap::new();
        map.insert(field::JOB_ID.into(), Value::BulkString(b"j".to_vec()));
        assert!(StreamEntry::from_field_map(&map).is_err());
    }

    #[test]
    fn child_entry_with_focus_roundtrips() {
        let entry = StreamEntry::new_child(
            "child-1".into(),
            JobKind::LinkEstimate,
            "shapley:whatif:payload:sweep-1".into(),
            "OPX".into(),
            "00ff".into(),
            1,
        );
        // Shared key, NOT derived from the child's own job_id.
        assert_eq!(entry.payload_key, "shapley:whatif:payload:sweep-1");
        assert_eq!(entry.schema, LINKEST_SCHEMA);
        let parsed = StreamEntry::from_field_map(&map_of(&entry)).expect("parse");
        assert_eq!(parsed, entry);
        assert_eq!(parsed.focus.as_deref(), Some("OPX"));
    }

    #[test]
    fn entry_without_focus_field_still_parses() {
        // Bytes from a pre-sweep producer carry no `focus` field at all — the
        // additive field must be absent on the wire, not an empty string.
        let entry = StreamEntry::new("job-3".into(), JobKind::LinkEstimate, "00ff".into(), 1);
        let map = map_of(&entry);
        assert!(!map.contains_key(field::FOCUS));
        let parsed = StreamEntry::from_field_map(&map).expect("parse");
        assert_eq!(parsed.focus, None);
    }

    #[test]
    fn sweep_and_baseline_schemas_are_stamped_and_supported() {
        let sweep = StreamEntry::new("s".into(), JobKind::Sweep, "00".into(), 1);
        assert_eq!(sweep.schema, SWEEP_SCHEMA);
        assert!(sweep.schema_supported());
        assert_eq!(JobKind::from_wire("sweep"), JobKind::Sweep);

        let baseline = StreamEntry::new("b".into(), JobKind::Baseline, "00".into(), 1);
        assert_eq!(baseline.schema, BASELINE_SCHEMA);
        assert!(baseline.schema_supported());
        assert_eq!(JobKind::from_wire("baseline"), JobKind::Baseline);
    }

    #[test]
    fn inflight_key_matches_keyspace() {
        assert_eq!(inflight_key("00ff"), "shapley:linkest:inflight:00ff");
    }
}
