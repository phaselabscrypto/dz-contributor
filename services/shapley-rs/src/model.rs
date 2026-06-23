//! Wire-level types matching the JSON our Next.js frontend already sends.
//!
//! These map onto `network_shapley::types::*` but stay decoupled so we
//! don't break the wire format if the upstream crate evolves.

use serde::{Deserialize, Serialize};

/// `device.edge` flag — 1 if validators present at this device, 0 otherwise.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct DeviceIn {
    pub device: String,
    pub edge: u32,
    pub operator: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct PrivateLinkIn {
    pub device1: String,
    pub device2: String,
    pub latency: f64,
    pub bandwidth: f64,
    pub uptime: f64,
    #[serde(default)]
    pub shared: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct PublicLinkIn {
    pub city1: String,
    pub city2: String,
    pub latency: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct DemandIn {
    pub start: String,
    pub end: String,
    pub receivers: u32,
    pub traffic: f64,
    pub priority: f64,
    #[serde(rename = "type")]
    pub kind: u32,
    pub multicast: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ShapleyInputIn {
    pub devices: Vec<DeviceIn>,
    pub private_links: Vec<PrivateLinkIn>,
    pub public_links: Vec<PublicLinkIn>,
    pub demands: Vec<DemandIn>,
    #[serde(default = "default_uptime")]
    pub operator_uptime: f64,
    #[serde(default = "default_contiguity")]
    pub contiguity_bonus: f64,
    #[serde(default = "default_demand_mult")]
    pub demand_multiplier: f64,
    /// Normalized per-source-city aggregation weights (metro code → weight,
    /// summing to 1.0) from the leader-schedule stake share. Mirrors DZ
    /// `ShapleyInputs.city_weights` (calculator/input.rs). Keyed identically to
    /// `DemandIn::start` so the per-city aggregation (routes::compute_per_city)
    /// can look up each source city's weight. `BTreeMap` for deterministic
    /// iteration, matching DZ.
    ///
    /// Empty when the client sent an input without leader-schedule data — the
    /// reward path treats that as an error rather than silently producing a
    /// non-DZ result.
    #[serde(default)]
    pub city_weights: std::collections::BTreeMap<String, f64>,
}

fn default_uptime() -> f64 {
    0.98
}
fn default_contiguity() -> f64 {
    5.0
}
fn default_demand_mult() -> f64 {
    1.0
}

// `Deserialize` is required (Phase 2) so the worker can read a cached
// `SimulateResponse` back out of the Redis `result:{hash}` idempotency cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShapleyOperatorOut {
    pub value: f64,
    pub share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShapleyResponse {
    pub method: String,
    pub operator_count: usize,
    pub values: std::collections::BTreeMap<String, ShapleyOperatorOut>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct LinkEstimateRequest {
    pub input: ShapleyInputIn,
    pub operator_focus: String,
}

/// Payload of a `JobKind::Sweep` job — stored ONCE per sweep under the sweep
/// job's payload key (24h TTL, `queue::SWEEP_PAYLOAD_TTL_SECS`) and shared by
/// every child link-estimate entry via `payload_key` + `focus`, so a
/// 20-operator sweep holds one copy of the epoch input in Redis, not twenty.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SweepPayload {
    pub input: ShapleyInputIn,
    pub operators: Vec<String>,
    /// Whether `operators` was derived service-side from the input's devices
    /// (⇒ guaranteed-complete set). Only derived sweeps may write the "fully
    /// swept" marker: an explicit — possibly partial — list carrying the
    /// canonical tag must never mark the epoch complete, or the cron would
    /// skip the unswept remainder forever. `#[serde(default)]` so a payload
    /// stored by a pre-field producer decodes as NOT derived (degrades to "no
    /// marker", never to a false marker).
    #[serde(default)]
    pub derived_operators: bool,
    /// Opaque caller tag (e.g. `epoch-{N}:canonical-v1:{params fingerprint}`)
    /// keying the S3 "fully swept" marker. `None` ⇒ no marker is written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

// One per focus-owned link, canonical `device1 < device2` orientation, mapped 1:1
// from `network_shapley::link_estimate::LinkEstimate`. `Deserialize` lets the
// worker read a cached `LinkEstimateResponse` back out of the Redis result cache.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinkEstimateOut {
    pub device1: String,
    pub device2: String,
    pub bandwidth: f64,
    pub latency: f64,
    /// The link's Shapley value (signed; negatives are clamped to 0 for `percent`
    /// and treated as "inconclusive" by the UI).
    pub value: f64,
    /// `max(value, 0) / Σ max(value, 0)` over the returned links — a 0–1 fraction.
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinkEstimateResponse {
    pub method: String,
    pub operator_focus: String,
    pub links: Vec<LinkEstimateOut>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
    pub version: &'static str,
}

// ── /simulate endpoint types ────────────────────────────────────────────

/// `POST /simulate` request: baseline + modified inputs in one shot.
///
/// `Serialize` is required (Phase 2) so the API role can persist the request as
/// the TTL'd `payload:{job_id}` String and hash it for the idempotency key.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SimulateRequest {
    /// The unmodified network topology (baseline).
    pub baseline: ShapleyInputIn,
    /// The modified topology (links added/removed by the simulator).
    pub modified: ShapleyInputIn,
}

/// `POST /simulate` response: before/after Shapley values + perf stats.
/// `Deserialize` lets the worker read it back from the Redis result cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulateResponse {
    pub baseline: ShapleyResponse,
    pub modified: ShapleyResponse,
    pub stats: SimulateStats,
}

/// Performance telemetry for the simulate endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulateStats {
    /// Whether the baseline was served from the epoch cache.
    pub baseline_cache_hit: bool,
    /// Under the per-city architecture the unit of reuse is a SOURCE CITY, not a
    /// coalition: this is the number of source cities whose Shapley values the
    /// modified run reused verbatim from the baseline. The wire field name is
    /// kept (`coalitions_reused`) for wire/UI stability.
    pub coalitions_reused: usize,
    /// Number of source cities solved fresh for the modified run (wire name kept
    /// for stability; see `coalitions_reused`).
    pub coalitions_solved: usize,
    /// Baseline compute wall-clock milliseconds (0 if cache hit).
    pub baseline_ms: u64,
    /// Modified compute wall-clock milliseconds.
    pub modified_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::SweepPayload;

    /// A sweep payload stored by a producer that predates `derived_operators`
    /// must decode as NOT derived: the field gates the "fully swept" marker,
    /// and the safe degradation for unknown provenance is "no marker", never
    /// a false one.
    #[test]
    fn sweep_payload_without_derived_flag_decodes_as_not_derived() {
        let legacy = r#"{
            "input": { "devices": [], "private_links": [], "public_links": [], "demands": [] },
            "operators": ["Alpha"],
            "tag": "epoch-1:canonical-v1"
        }"#;
        let payload: SweepPayload = serde_json::from_str(legacy).expect("legacy payload parses");
        assert!(!payload.derived_operators);
        assert_eq!(payload.tag.as_deref(), Some("epoch-1:canonical-v1"));
    }
}
