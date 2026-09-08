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

/// Which canonical input built a baseline. The two variants hash differently,
/// so an alias records which one produced it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BaselineVariant {
    Foundation,
    Snapshot,
}

impl BaselineVariant {
    /// The wire spelling, also used in log lines and job summaries.
    pub fn as_str(self) -> &'static str {
        match self {
            BaselineVariant::Foundation => "foundation",
            BaselineVariant::Snapshot => "snapshot",
        }
    }
}

impl std::fmt::Display for BaselineVariant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The published baseline for one tag. Stored as the alias object and returned
/// verbatim by `GET /shapley/baseline`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaselineAlias {
    pub tag: String,
    pub variant: BaselineVariant,
    /// `cache::hash_input` of the input as `{:016x}`; names the `cache-` object.
    pub input_hash: String,
    #[serde(flatten)]
    pub result: ShapleyResponse,
}

/// Payload of a `JobKind::BaselinePublish` job.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct BaselinePublishPayload {
    pub input: ShapleyInputIn,
    pub tag: String,
    pub variant: BaselineVariant,
    /// Set by the ingest-authenticated producer. A payload stored without it
    /// decodes as unauthorized and publishes nothing.
    #[serde(default)]
    pub is_publish_authorized: bool,
}

impl BaselinePublishPayload {
    /// The tag this job may publish under: `Some` only when the producer was
    /// authorized and the tag has no NUL byte, which the alias key uses as its
    /// separator.
    pub(crate) fn publish_tag(&self) -> Option<&str> {
        (self.is_publish_authorized && !self.tag.contains('\0')).then_some(self.tag.as_str())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct LinkEstimateRequest {
    pub input: ShapleyInputIn,
    pub operator_focus: String,
}

/// Stored once per sweep and shared by its queued children.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SweepPayload {
    pub input: ShapleyInputIn,
    pub operators: Vec<String>,
    /// True when the service derived `operators` from the input's devices.
    /// Only a derived set is complete, so an explicit list never publishes
    /// aliases or marks the epoch swept. A payload stored before the field
    /// existed decodes as not derived.
    #[serde(default)]
    pub derived_operators: bool,
    /// Set by the ingest-authenticated producer. A payload stored before the
    /// field existed decodes as unauthorized and cannot publish.
    #[serde(default)]
    pub is_publish_authorized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

impl SweepPayload {
    /// The tag this sweep may publish aliases and its marker under. `None`
    /// when publication is not allowed: the sweep did not come through the
    /// ingest-authenticated route, its operator list is not derived, or a
    /// value carries the NUL byte the alias key uses as its separator.
    pub(crate) fn publish_tag(&self) -> Option<&str> {
        self.tag.as_deref().filter(|tag| {
            self.is_publish_authorized
                && self.derived_operators
                && !tag.contains('\0')
                && self.operators.iter().all(|op| !op.contains('\0'))
        })
    }
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
    use super::{BaselineAlias, BaselinePublishPayload, BaselineVariant, SweepPayload};

    #[test]
    fn baseline_variant_serializes_lowercase_and_rejects_unknown() {
        assert_eq!(
            serde_json::to_string(&BaselineVariant::Foundation).unwrap(),
            "\"foundation\""
        );
        assert_eq!(
            serde_json::from_str::<BaselineVariant>("\"snapshot\"").unwrap(),
            BaselineVariant::Snapshot
        );
        assert!(serde_json::from_str::<BaselineVariant>("\"nightly\"").is_err());
        assert_eq!(BaselineVariant::Snapshot.to_string(), "snapshot");
    }

    #[test]
    fn baseline_publish_payload_without_authorization_decodes_as_unauthorized() {
        let stored = r#"{
            "input": { "devices": [], "private_links": [], "public_links": [], "demands": [] },
            "tag": "baseline:epoch-1:canonical-v1:00",
            "variant": "foundation"
        }"#;
        let payload: BaselinePublishPayload = serde_json::from_str(stored).unwrap();
        assert!(!payload.is_publish_authorized);
        assert_eq!(payload.publish_tag(), None);

        let authorized = BaselinePublishPayload {
            is_publish_authorized: true,
            ..payload.clone()
        };
        assert_eq!(
            authorized.publish_tag(),
            Some("baseline:epoch-1:canonical-v1:00")
        );
        let nul = BaselinePublishPayload {
            tag: "bad\0tag".into(),
            ..authorized
        };
        assert_eq!(nul.publish_tag(), None);
    }

    #[test]
    fn baseline_alias_flattens_result_fields() {
        let alias = BaselineAlias {
            tag: "t".into(),
            variant: BaselineVariant::Foundation,
            input_hash: "00000000000000aa".into(),
            result: super::ShapleyResponse {
                method: "m".into(),
                operator_count: 0,
                values: Default::default(),
            },
        };
        let value = serde_json::to_value(&alias).unwrap();
        for key in [
            "tag",
            "variant",
            "input_hash",
            "method",
            "operator_count",
            "values",
        ] {
            assert!(value.get(key).is_some(), "missing top-level {key}");
        }
        assert!(value.get("result").is_none(), "result must be flattened");
    }

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
