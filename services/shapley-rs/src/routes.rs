//! HTTP route handlers. Translate wire-types into the canonical
//! `network_shapley` crate types, run the LP solver, and translate
//! results back out.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};

use crate::cache::{self, BaselineResult, EpochCache, OperatorCache};
use crate::model::{
    HealthResponse, LinkEstimateOut, LinkEstimateRequest, LinkEstimateResponse, ShapleyInputIn,
    ShapleyOperatorOut, ShapleyResponse, SimulateRequest, SimulateResponse, SimulateStats,
    SweepPayload,
};

use network_shapley::{
    shapley::{ComputeControl, ComputeOptions, ShapleyInput},
    types::{Demand, Device, PrivateLink, PublicLink},
};

pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "dz-shapley-service",
        version: env!("CARGO_PKG_VERSION"),
    })
}

pub(crate) fn build_input(input: &ShapleyInputIn) -> ShapleyInput {
    let private_links = input
        .private_links
        .iter()
        .map(|l| {
            PrivateLink::new(
                l.device1.clone(),
                l.device2.clone(),
                l.latency,
                l.bandwidth,
                l.uptime,
                l.shared,
            )
        })
        .collect::<Vec<_>>();

    // Devices arrive with unique per-operator names from the TS input builder
    // (e.g. FRA1 for operator Cherry, FRA2 for operator Jump). This matches
    // the canonical DZ format where each device name maps to exactly one
    // operator.  We validate uniqueness and warn if duplicates slip through
    // (which would indicate a bug in the upstream builder).
    let mut seen_devices = BTreeMap::<String, String>::new();
    for d in &input.devices {
        if let Some(prev_op) = seen_devices.get(&d.device) {
            if *prev_op != d.operator {
                tracing::warn!(
                    device = %d.device,
                    prev_operator = %prev_op,
                    new_operator = %d.operator,
                    "duplicate device name with different operators — input builder bug"
                );
            }
        } else {
            seen_devices.insert(d.device.clone(), d.operator.clone());
        }
    }
    let devices = input
        .devices
        .iter()
        .map(|d| Device::new(d.device.clone(), d.edge, d.operator.clone()))
        .collect::<Vec<_>>();

    let public_links = input
        .public_links
        .iter()
        .map(|l| PublicLink::new(l.city1.clone(), l.city2.clone(), l.latency))
        .collect::<Vec<_>>();

    // --- Demand type normalisation ---
    //
    // The upstream LP models each demand `type` as a single-source
    // multi-commodity flow.  All demands sharing a type **must** have
    // identical (start, multicast, priority) — otherwise the flow
    // conservation constraints are ill-formed and the crate rejects the
    // input with "Data inconsistency: Demand type N has inconsistent
    // properties".
    //
    // Clients may send flat type IDs (e.g. type=1 for all IBRL, type=2
    // for all Shred) which violates this when multiple source cities
    // exist.  We fix this here by assigning a unique type per
    // (start, multicast, priority) group — the correct commodity
    // partitioning for the LP solver.
    use std::collections::HashMap;

    /// Key that uniquely identifies a commodity class for the LP.
    #[derive(Hash, Eq, PartialEq)]
    struct CommodityKey {
        start: String,
        multicast: bool,
        /// Priority as integer-encoded bits for Eq/Hash (f64 is not Hash).
        priority_bits: u64,
    }

    let mut type_map: HashMap<CommodityKey, u32> = HashMap::new();
    let mut next_type: u32 = 1;

    let demands = input
        .demands
        .iter()
        .map(|d| {
            let key = CommodityKey {
                start: d.start.clone(),
                multicast: d.multicast,
                priority_bits: d.priority.to_bits(),
            };
            let assigned_type = *type_map.entry(key).or_insert_with(|| {
                let t = next_type;
                next_type += 1;
                t
            });
            Demand::new(
                d.start.clone(),
                d.end.clone(),
                d.receivers,
                d.traffic,
                d.priority,
                assigned_type,
                d.multicast,
            )
        })
        .collect::<Vec<_>>();

    ShapleyInput {
        private_links,
        devices,
        demands,
        public_links,
        operator_uptime: input.operator_uptime,
        contiguity_bonus: input.contiguity_bonus,
        demand_multiplier: input.demand_multiplier,
    }
}

/// Maximum number of elements per input array to prevent pathological inputs
/// from consuming unbounded CPU in the LP solver.
const MAX_DEVICES: usize = 500;
const MAX_LINKS: usize = 2_000;
const MAX_DEMANDS: usize = 2_000;

/// Maximum distinct operators (Shapley "players"). Every coalition LP — on both
/// the monolithic `/shapley` path and the per-city reward path (where each city
/// solve enumerates the FULL operator set; see `compute_per_city`) — costs
/// `2^operators` LPs, so the engine's exact solve is infeasible past ~20. We
/// reject above the cap at the API boundary so an oversized input fails fast and
/// cheap, instead of allocating its way into the engine and timing out on the
/// shared worker. Real epochs sit well under this (e.g. epoch-149 ≈ 14).
const MAX_OPERATORS: usize = 20;

fn validate_dimensions(input: &ShapleyInputIn) -> Result<(), String> {
    if input.devices.len() > MAX_DEVICES {
        return Err(format!(
            "devices count {} exceeds limit {}",
            input.devices.len(),
            MAX_DEVICES
        ));
    }
    if input.private_links.len() > MAX_LINKS {
        return Err(format!(
            "private_links count {} exceeds limit {}",
            input.private_links.len(),
            MAX_LINKS
        ));
    }
    if input.public_links.len() > MAX_LINKS {
        return Err(format!(
            "public_links count {} exceeds limit {}",
            input.public_links.len(),
            MAX_LINKS
        ));
    }
    if input.demands.len() > MAX_DEMANDS {
        return Err(format!(
            "demands count {} exceeds limit {}",
            input.demands.len(),
            MAX_DEMANDS
        ));
    }
    let operator_count = input
        .devices
        .iter()
        .map(|d| d.operator.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    if operator_count > MAX_OPERATORS {
        return Err(format!(
            "operator count {operator_count} exceeds the {MAX_OPERATORS}-operator \
             exact-solve limit (each coalition LP enumerates 2^operators; the engine \
             cannot solve beyond this on any path)"
        ));
    }
    Ok(())
}

// ── Per-city exact Shapley + stake-weighted aggregation (DZ parity) ──────────
//
// Mirrors DoubleZero `contributor-rewards/v0.5.3` exactly:
//   • calculator/shapley/evaluator.rs::compute_shapley_values — group demands by
//     SOURCE city (`demand.start`), run the engine's EXACT `compute()` per city
//     in parallel (rayon). NO Monte-Carlo sampling on the reward path: DZ always
//     computes exact, and each per-city LP is small (one source city's demands).
//   • calculator/shapley/aggregator.rs::aggregate_shapley_outputs — for each
//     city, `operator_value[op] += value * weight`; skip zero-weight cities;
//     `share = value / Σ value`, RAW (can be negative or >1 — DZ clamps only at
//     reward-leaf time in proof.rs, never here).
//   • calculator/util.rs::calculate_city_weights — the weights are computed
//     TS-side (leader-schedule stake share) and arrive as
//     `ShapleyInputIn.city_weights`, keyed identically to `demand.start`.
//
// The `network-shapley-rs` engine sees nothing special here. Each city's demands
// go through the standard `build_input`: its per-(start,multicast,priority)
// commodity retag is *normalised away* by the engine's `consolidate_demand`, which
// re-derives one commodity per multicast row and one per unicast priority class
// regardless of the incoming type ids — so a city solved via `build_input` is
// byte-identical to DZ feeding raw kind-1/2 demands. MAX_OPERATORS (20) is
// enforced by the engine; that error propagates rather than triggering any
// silent fallback.

/// Failure of [`compute_per_city`], separating cooperative cancellation (a
/// terminal `cancelled`, not a user-facing error) from a real compute failure.
#[derive(Debug)]
pub(crate) enum PerCityError {
    /// `control.cancel` was observed between cities.
    Cancelled,
    /// A city's LP failed (e.g. `TooManyOperators`), or the input was
    /// non-canonical (no `city_weights`). Carries a human-readable message.
    Failed(String),
}

impl PerCityError {
    pub(crate) fn message(&self) -> String {
        match self {
            PerCityError::Cancelled => "cancelled".to_string(),
            PerCityError::Failed(m) => m.clone(),
        }
    }
}

/// One source city's raw (UN-weighted) Shapley values: `(operator, value)`,
/// operator-sorted (the engine returns a `BTreeMap`). The reusable unit of a
/// what-if under the per-city architecture.
pub(crate) type CityValues = Vec<(String, f64)>;

/// Result of a per-city decomposition.
pub(crate) struct PerCityResult {
    /// Raw (UN-weighted) Shapley value per operator, per source city,
    /// operator-sorted. Cached so a what-if can reuse cities it didn't change.
    pub per_city: BTreeMap<String, CityValues>,
    /// Stake-weighted, normalized reward map — the DZ-faithful output.
    pub aggregated: BTreeMap<String, ShapleyOperatorOut>,
    pub method: String,
    /// Telemetry: cities solved fresh vs reused from the baseline.
    pub cities_solved: usize,
    pub cities_reused: usize,
}

/// Advance the progress counters by `n` solved coalitions so the worker's bridge
/// renders `coalitions_solved / total_coalitions` (see `jobs::running_percent`).
/// Used for reused (B3) cities, which skip the engine solve but should still count
/// their full coalition share instantly. Solved cities are counted per-LP by the
/// engine's `compute_with`. No-op without a control.
fn bump_solved(control: Option<&ComputeControl>, n: usize) {
    if let Some(c) = control {
        use std::sync::atomic::Ordering;
        c.progress.batch_solved.fetch_add(n, Ordering::Relaxed);
        c.progress.coalitions_solved.fetch_add(n, Ordering::Relaxed);
    }
}

/// Group demands by source city, run the EXACT engine per city (cities solved
/// SEQUENTIALLY; each city's coalition solve is rayon-parallel internally), and
/// stake-weight-aggregate — the DZ-faithful reward computation.
///
/// Cities are sequential on purpose: the engine's warm-start coalition solver is a
/// per-rayon-worker thread-local keyed by a problem epoch. Running cities in
/// parallel would nest the city loop over the engine's coalition `par_iter`, so a
/// worker stealing coalitions across cities would rebuild its full-size HiGHS model
/// every switch — negating the warm-start (and, with presolve off + full-size
/// model, potentially slower than fresh builds). Sequential cities let each
/// city's coalition loop own the whole pool warm; the only cross-city cost is one
/// model rebuild per worker at each city boundary (negligible).
///
/// `reuse` supplies baseline per-city values for cities the caller proved
/// unchanged (see [`reusable_city_values`]); those skip the solve. Pass an empty
/// map for a full fresh computation. `control`, when present, makes the loop
/// cooperatively cancellable (checked between cities) and drives a
/// cities-completed progress bar.
pub(crate) fn compute_per_city(
    input: &ShapleyInputIn,
    reuse: &BTreeMap<String, CityValues>,
    control: Option<&ComputeControl>,
) -> Result<PerCityResult, PerCityError> {
    use std::sync::atomic::Ordering;

    // Non-canonical input has no leader-schedule stake data → refuse rather than
    // silently produce a non-DZ (monolithic) result.
    if input.city_weights.is_empty() {
        return Err(PerCityError::Failed(
            "city_weights missing — non-canonical input is not allowed on the \
             per-city reward path (no monolithic fallback)"
                .to_string(),
        ));
    }

    // Group demands by START city (evaluator.rs:46-56), deterministic order.
    let mut by_city: BTreeMap<String, Vec<crate::model::DemandIn>> = BTreeMap::new();
    for d in &input.demands {
        by_city.entry(d.start.clone()).or_default().push(d.clone());
    }

    // Pre-skip zero-weight cities: aggregator.rs:42-45 skips them in the sum, and
    // a zero-weight city contributes nothing to any operator, so not solving it
    // is result-identical and saves a full coalition enumeration. (When the
    // global stake total is 0, calculate_city_weights yields uniform 1/n > 0, so
    // nothing is dropped here.)
    let to_solve: Vec<(String, Vec<crate::model::DemandIn>)> = by_city
        .into_iter()
        .filter(|(city, _)| input.city_weights.get(city).copied().unwrap_or(0.0) != 0.0)
        .collect();

    // COALITION-level progress, aggregated across the per-city solves. Every city
    // enumerates the SAME operator set (shared topology) → each runs
    // `coalitions_per_city` = 2^operators LPs; total = cities × that. The engine's
    // `compute_with` bumps coalitions_solved/batch_solved per LP, so the bar
    // climbs smoothly across all cities' LPs (cities run one at a time now, but the
    // bar is per-LP so it still advances continuously). Reused (B3) cities count their share via
    // `bump_solved`. Priming the existing batch fields keeps `jobs::running_percent`
    // unchanged — it reduces to `batch_solved / total_coalitions`.
    let coalitions_per_city = build_input(input).coalition_count();
    let total_coalitions = to_solve.len() * coalitions_per_city;
    if let Some(c) = control {
        let p = &c.progress;
        p.reset();
        p.max_samples.store(total_coalitions, Ordering::Relaxed);
        p.batch_samples.store(total_coalitions, Ordering::Relaxed);
        p.batch_total.store(total_coalitions, Ordering::Relaxed);
    }

    // Solve each surviving city's EXACT Shapley SEQUENTIALLY (evaluator.rs:59-114)
    // so the engine's per-coalition warm-start owns the rayon pool one city at a
    // time (see the fn doc). Each city's solve is itself rayon-parallel over its
    // 2^operators coalitions. Collecting into `Result` short-circuits on the first
    // error / cancel.
    let solved: Vec<(String, CityValues, bool)> = to_solve
        .iter()
        .map(|(city, demands)| -> Result<_, PerCityError> {
            // Cooperative cancel between cities (the engine's exact compute() is
            // not itself cancellable, so this bounds cancel latency to one city).
            if control.is_some_and(|c| c.cancel.load(Ordering::Relaxed)) {
                return Err(PerCityError::Cancelled);
            }
            // Reuse the baseline value if this city was unchanged by the what-if.
            if let Some(values) = reuse.get(city) {
                bump_solved(control, coalitions_per_city);
                return Ok((city.clone(), values.clone(), true));
            }
            // This city's LP: shared topology, this city's demands only.
            let city_input = ShapleyInputIn {
                devices: input.devices.clone(),
                private_links: input.private_links.clone(),
                public_links: input.public_links.clone(),
                demands: demands.clone(),
                operator_uptime: input.operator_uptime,
                contiguity_bonus: input.contiguity_bonus,
                demand_multiplier: input.demand_multiplier,
                city_weights: BTreeMap::new(), // unused by the per-city LP
            };
            let engine_input = build_input(&city_input);
            // EXACT solve. With a control, `compute_with` reports per-coalition
            // progress (feeding the aggregated bar) and honours cancel mid-solve;
            // without one, plain `compute()` (sync callers, unchanged).
            let out = match control {
                Some(c) => engine_input.compute_with(ComputeOptions {
                    control: Some(Box::new(c.clone())),
                    ..Default::default()
                }),
                None => engine_input.compute(),
            }
            .map_err(|e| match e {
                network_shapley::error::ShapleyError::Cancelled => PerCityError::Cancelled,
                other => PerCityError::Failed(format!("city {city}: {other}")),
            })?;
            // ShapleyOutput is a BTreeMap → operator-sorted, deterministic.
            let values: Vec<(String, f64)> =
                out.into_iter().map(|(op, sv)| (op, sv.value)).collect();
            Ok((city.clone(), values, false))
        })
        .collect::<Result<Vec<_>, PerCityError>>()?;

    let cities_reused = solved.iter().filter(|(_, _, reused)| *reused).count();
    let cities_solved = solved.len() - cities_reused;
    let per_city: BTreeMap<String, Vec<(String, f64)>> = solved
        .into_iter()
        .map(|(city, values, _)| (city, values))
        .collect();

    // Stake-weight-aggregate into the final DZ-faithful reward map.
    let aggregated = aggregate_per_city(&per_city, &input.city_weights);

    Ok(PerCityResult {
        per_city,
        aggregated,
        method: "lp-per-city-stake-weighted-exact".to_string(),
        cities_solved,
        cities_reused,
    })
}

/// Stake-weight-aggregate per-city Shapley values into the final reward map —
/// a faithful port of DZ `aggregate_shapley_outputs` (aggregator.rs:16-67):
///   • `operator_value[op] += value * weight` across cities;
///   • cities with weight 0 are skipped entirely (aggregator.rs:42-45);
///   • `share = value / Σ value`, RAW — can be negative or >1 when Shapley
///     values are negative (aggregator.rs:59-63). DZ clamps only at reward-leaf
///     time in proof.rs; we never clamp here.
pub(crate) fn aggregate_per_city(
    per_city: &BTreeMap<String, CityValues>,
    city_weights: &BTreeMap<String, f64>,
) -> BTreeMap<String, ShapleyOperatorOut> {
    let mut operator_value: BTreeMap<String, f64> = BTreeMap::new();
    for (city, values) in per_city {
        let weight = city_weights.get(city).copied().unwrap_or(0.0);
        if weight == 0.0 {
            continue;
        }
        for (op, value) in values {
            *operator_value.entry(op.clone()).or_insert(0.0) += value * weight;
        }
    }
    let total: f64 = operator_value.values().sum();
    operator_value
        .into_iter()
        .map(|(op, value)| {
            let share = if total != 0.0 { value / total } else { 0.0 };
            (op, ShapleyOperatorOut { value, share })
        })
        .collect()
}

/// Cities whose per-city Shapley result the modified what-if can reuse verbatim
/// from the baseline. Sound ONLY when the SHARED topology (devices, private
/// links, public links, tuning params) is byte-identical AND that source city's
/// demand list is unchanged — every per-city LP reads the shared topology, so
/// any topology edit (add/remove/retune a link) invalidates all cities, while a
/// pure demand-override what-if can reuse the cities it didn't touch.
/// Conservative: any difference yields a (correct) fresh re-solve.
pub(crate) fn reusable_city_values(
    baseline: &ShapleyInputIn,
    modified: &ShapleyInputIn,
    baseline_per_city: &BTreeMap<String, CityValues>,
) -> BTreeMap<String, CityValues> {
    if baseline.devices != modified.devices
        || baseline.private_links != modified.private_links
        || baseline.public_links != modified.public_links
        || baseline.operator_uptime != modified.operator_uptime
        || baseline.contiguity_bonus != modified.contiguity_bonus
        || baseline.demand_multiplier != modified.demand_multiplier
    {
        return BTreeMap::new();
    }
    let group = |inp: &ShapleyInputIn| {
        let mut m: BTreeMap<String, Vec<crate::model::DemandIn>> = BTreeMap::new();
        for d in &inp.demands {
            m.entry(d.start.clone()).or_default().push(d.clone());
        }
        m
    };
    let base_by_city = group(baseline);
    let mod_by_city = group(modified);
    let mut out = BTreeMap::new();
    for (city, base_demands) in &base_by_city {
        // Identical demand vec (order included) ⇒ identical LP for this city.
        if mod_by_city.get(city) == Some(base_demands)
            && let Some(values) = baseline_per_city.get(city)
        {
            out.insert(city.clone(), values.clone());
        }
    }
    out
}

/// Build a wire `ShapleyResponse` from a cached baseline result.
fn response_from_baseline(baseline: &BaselineResult) -> ShapleyResponse {
    let values: BTreeMap<String, ShapleyOperatorOut> = baseline
        .values
        .iter()
        .map(|(op, oc)| {
            (
                op.clone(),
                ShapleyOperatorOut {
                    value: oc.value,
                    share: oc.share,
                },
            )
        })
        .collect();
    ShapleyResponse {
        method: baseline.method.clone(),
        operator_count: baseline.operator_count,
        values,
    }
}

/// Serve a baseline for `input_hash` from the in-memory cache, falling back to
/// S3 (rehydrating the in-memory cache on an S3 hit). Returns `None` on a full
/// miss. Cheap on the hot path — only clones the (small) baseline, not the
/// coalition map. The lookup is keyed by the topology hash, so a hit is always
/// for the exact same input.
pub(crate) async fn try_cached_baseline(
    state: &crate::AppState,
    input_hash: u64,
) -> Option<ShapleyResponse> {
    // In-memory first.
    {
        let guard = state.epoch_cache.read().await;
        if let Some(c) = guard.as_ref()
            && c.input_hash == input_hash
            && let Some(b) = &c.baseline_values
        {
            tracing::info!(
                cities_cached = c.per_city_values.len(),
                "baseline cache hit (memory)"
            );
            return Some(response_from_baseline(b));
        }
    }

    // S3 fallback — rehydrate the in-memory cache so subsequent requests
    // (and warm-start coalition reuse) hit memory.
    let s3 = state.s3_cache.as_ref()?;
    let loaded = s3.load(input_hash).await?;
    if loaded.input_hash != input_hash {
        return None;
    }
    let resp = match loaded.baseline_values.as_ref() {
        Some(b) => response_from_baseline(b),
        None => return None,
    };
    {
        let mut guard = state.epoch_cache.write().await;
        *guard = Some(loaded);
    }
    tracing::info!("baseline cache hit (S3 rehydrate)");
    Some(resp)
}

/// Compute the baseline Shapley values for `body`, store them in the in-memory
/// epoch cache, and persist to S3 in the background. Shared by `/shapley` and
/// the background `/precompute`. Returns the wire response or an error string.
pub(crate) async fn compute_and_store_baseline(
    state: &crate::AppState,
    body: &ShapleyInputIn,
    input_hash: u64,
    // When `Some`, the per-city solve reports progress (one unit per source city)
    // and honours cancellation through this control, so the async worker can show
    // a moving bar during a cold baseline. The synchronous endpoints pass `None`.
    control: Option<&ComputeControl>,
) -> Result<ShapleyResponse, String> {
    let operator_count = body
        .devices
        .iter()
        .map(|d| d.operator.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    tracing::info!(
        operators = operator_count,
        demands = body.demands.len(),
        "computing shapley baseline (cache miss) — per-city exact"
    );

    // Per-city EXACT solve off the tokio thread. A cold baseline has no reuse
    // seed; the per-city values we produce ARE what later what-if runs reuse.
    // `ComputeControl` is Arc-backed, so the clone keeps the caller's bridge
    // sharing the progress/cancel state.
    let body_owned = body.clone();
    let control = control.cloned();
    let start = std::time::Instant::now();
    let result = tokio::task::spawn_blocking(move || {
        compute_per_city(&body_owned, &BTreeMap::new(), control.as_ref())
    })
    .await
    .map_err(|e| format!("compute task panicked: {e}"))?;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    let per_city_result = result.map_err(|e| {
        let msg = e.message();
        tracing::error!(error = %msg, elapsed_ms, "shapley baseline compute failed");
        msg
    })?;
    tracing::info!(
        elapsed_ms,
        operators = operator_count,
        cities = per_city_result.cities_solved + per_city_result.cities_reused,
        method = %per_city_result.method,
        "shapley baseline compute finished"
    );

    let values = per_city_result.aggregated;
    let response = ShapleyResponse {
        method: per_city_result.method.clone(),
        operator_count: values.len(),
        values: values.clone(),
    };

    let baseline = BaselineResult {
        method: per_city_result.method,
        operator_count: values.len(),
        values: values
            .iter()
            .map(|(op, v)| {
                (
                    op.clone(),
                    OperatorCache {
                        value: v.value,
                        share: v.share,
                    },
                )
            })
            .collect(),
    };

    {
        let mut guard = state.epoch_cache.write().await;
        let cache = guard.get_or_insert_with(|| EpochCache::new(input_hash));
        if cache.input_hash != input_hash {
            *cache = EpochCache::new(input_hash);
        }
        // Store the raw per-city values so a subsequent what-if can reuse the
        // source cities it doesn't change (see `reusable_city_values`).
        cache.per_city_values = per_city_result.per_city;
        cache.baseline_values = Some(baseline);

        // Persist to S3 in the background.
        if let Some(s3) = &state.s3_cache {
            let cache_clone = cache.clone();
            let s3_bucket = s3.bucket_name().to_string();
            let s3_client = s3.client_ref().clone();
            tokio::spawn(async move {
                let s3 = cache::S3CacheRef {
                    client: s3_client,
                    bucket: s3_bucket,
                };
                s3.store(&cache_clone).await;
            });
        }
    }

    Ok(response)
}

pub async fn shapley(
    State(state): State<Arc<crate::AppState>>,
    Json(body): Json<ShapleyInputIn>,
) -> impl IntoResponse {
    if let Err(msg) = validate_dimensions(&body) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response();
    }

    let input_hash = cache::hash_input(&body);

    // ── Warm path: serve from in-memory or S3 cache, no compute ──────
    if let Some(resp) = try_cached_baseline(&state, input_hash).await {
        return Json(resp).into_response();
    }

    // ── Cold path: compute + store. The in-process compute load-shed was
    // removed in Phase 2 (ADR 0001) — the heavy what-if path runs on the
    // worker pool now; this synchronous endpoint is bounded only by the
    // request timeout + body-size limit.
    match compute_and_store_baseline(&state, &body, input_hash, None).await {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// `POST /precompute`: warm the baseline cache for an epoch as a QUEUED job.
///
/// Validates the input; already-cached → `200 already-cached`; else enqueues a
/// `JobKind::Baseline` job (`202 {job_id, input_hash}`) that a WORKER computes
/// and stores (memory + S3), with progress + cancellation via `GET/DELETE
/// /jobs/{id}`. Replaces the old `tokio::spawn`-on-the-API-pod fire-and-forget,
/// which was lost on any rollout/SIGTERM, had no job id/status/retry, and was
/// the one remaining violation of ADR 0001's "heavy compute runs on workers".
/// No Redis → 503 (fail-loud, not a silent in-process spawn).
pub async fn precompute(
    State(state): State<Arc<crate::AppState>>,
    Json(body): Json<ShapleyInputIn>,
) -> impl IntoResponse {
    if let Err(msg) = validate_dimensions(&body) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response();
    }

    let input_hash = cache::hash_input(&body);
    let hash_hex = format!("{input_hash:016x}");

    if try_cached_baseline(&state, input_hash).await.is_some() {
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "already-cached", "input_hash": hash_hex })),
        )
            .into_response();
    }

    let Some(store) = state.jobs.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "async jobs disabled (REDIS_URL not configured) — precompute requires the job queue",
            })),
        )
            .into_response();
    };

    let job_id = match store.create().await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(error = %e, "precompute: failed to create job");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "job store unavailable" })),
            )
                .into_response();
        }
    };

    match store
        .enqueue(&job_id, crate::queue::JobKind::Baseline, &body)
        .await
    {
        Ok(_) => {
            tracing::info!(job_id, input_hash = %hash_hex, "baseline precompute job enqueued");
            (
                StatusCode::ACCEPTED,
                Json(serde_json::json!({
                    "status": "accepted",
                    "job_id": job_id,
                    "input_hash": hash_hex,
                })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, job_id, "precompute: enqueue failed");
            let _ = store.set_failed(&job_id, "enqueue failed").await;
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "enqueue failed" })),
            )
                .into_response()
        }
    }
}

/// What-if simulation: compute baseline + modified Shapley in one shot,
/// reusing the baseline's per-city values for source cities the what-if
/// didn't change.
///
/// The caller (Next.js `/api/shapley/simulate`) sends both the unmodified
/// and modified `ShapleyInputIn` payloads. This endpoint:
///  1. Computes (or serves from cache) the baseline per-city Shapley values.
///  2. Reuses those values for unchanged source cities (`reusable_city_values`)
///     and re-solves only the cities whose demands the what-if touched — a
///     topology edit invalidates all cities; a demand-only edit reuses the rest.
///  3. Returns both results plus performance stats.
pub async fn simulate(
    State(state): State<Arc<crate::AppState>>,
    Json(body): Json<SimulateRequest>,
) -> impl IntoResponse {
    // ── Validate both inputs ────────────────────────────────────────
    if let Err(msg) = validate_dimensions(&body.baseline) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": format!("baseline: {msg}") })),
        )
            .into_response();
    }
    if let Err(msg) = validate_dimensions(&body.modified) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": format!("modified: {msg}") })),
        )
            .into_response();
    }

    let baseline_hash = cache::hash_input(&body.baseline);

    // ── Step 1: Baseline (memory/S3 cache hit, else compute + store) ─
    let baseline_start = std::time::Instant::now();
    let (baseline_response, baseline_cache_hit) = match try_cached_baseline(&state, baseline_hash)
        .await
    {
        Some(resp) => {
            tracing::info!("simulate: baseline cache hit");
            (resp, true)
        }
        None => match compute_and_store_baseline(&state, &body.baseline, baseline_hash, None).await
        {
            Ok(resp) => (resp, false),
            Err(e) => {
                tracing::error!(error = %e, "simulate: baseline compute failed");
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(serde_json::json!({ "error": format!("baseline: {e}") })),
                )
                    .into_response();
            }
        },
    };
    let baseline_ms = baseline_start.elapsed().as_millis() as u64;

    // ── Step 2: Modified run (per-city EXACT, DZ-faithful) ───────────
    // Reuse the baseline's per-city values for source cities this what-if didn't
    // change (see `reusable_city_values`): a link/device edit touches the shared
    // topology and invalidates every city, but a pure demand-override reuses the
    // cities it left untouched. The seed is the baseline's own per-city values,
    // provenance-checked by `input_hash`; empty ⇒ every city solved fresh.
    let reuse: BTreeMap<String, Vec<(String, f64)>> = {
        let guard = state.epoch_cache.read().await;
        guard
            .as_ref()
            .filter(|c| c.input_hash == baseline_hash)
            .map(|c| reusable_city_values(&body.baseline, &body.modified, &c.per_city_values))
            .unwrap_or_default()
    };
    let mod_operator_count = body
        .modified
        .devices
        .iter()
        .map(|d| d.operator.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    tracing::info!(
        operators = mod_operator_count,
        cities_reusable = reuse.len(),
        "simulate: computing modified (per-city exact)"
    );

    let modified_input = body.modified.clone();
    let modified_start = std::time::Instant::now();
    let mod_result =
        tokio::task::spawn_blocking(move || compute_per_city(&modified_input, &reuse, None))
            .await
            .expect("modified task panicked");
    let modified_ms = modified_start.elapsed().as_millis() as u64;

    // `coalitions_reused`/`coalitions_solved` now carry per-CITY counts (the unit
    // of reuse under the per-city architecture). The wire field names are kept
    // for stability; see `SimulateStats` docs.
    let (modified_response, coalitions_solved, coalitions_reused) = match mod_result {
        Ok(per_city_result) => {
            tracing::info!(
                elapsed_ms = modified_ms,
                cities_reused = per_city_result.cities_reused,
                cities_solved = per_city_result.cities_solved,
                "simulate: modified compute finished"
            );
            let values = per_city_result.aggregated;
            let resp = ShapleyResponse {
                method: per_city_result.method,
                operator_count: values.len(),
                values,
            };
            (
                resp,
                per_city_result.cities_solved,
                per_city_result.cities_reused,
            )
        }
        Err(e) => {
            let msg = e.message();
            tracing::error!(error = %msg, "simulate: modified compute failed");
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({ "error": format!("modified: {msg}") })),
            )
                .into_response();
        }
    };

    Json(SimulateResponse {
        baseline: baseline_response,
        modified: modified_response,
        stats: SimulateStats {
            baseline_cache_hit,
            coalitions_reused,
            coalitions_solved,
            baseline_ms,
            modified_ms,
        },
    })
    .into_response()
}

/// Cap on focus-owned links for the SYNC `/link-estimate` path. Players =
/// focus links + "Others", so 12 links → 2^13 = 8,192 coalition LPs — the most
/// a request can plausibly finish inside the 120s request timeout at production
/// LP scale (epoch-149: 2^14 ≈ 290s). A 20-player request would be 2^20 ≈ 1.05M
/// LPs (hours): accepting it on the sync path can only ever burn the rayon pool
/// until the timeout cancels it, so reject it loudly up front and direct the
/// caller to `POST /jobs/link-estimate` (progress + cancellation). The async
/// path is bounded by the engine's 20-player cap only.
const SYNC_MAX_FOCUS_LINKS: usize = 12;

/// Count the focus operator's links (OR ownership — either endpoint's device
/// belongs to the focus operator), mirroring the engine's retag semantics.
pub(crate) fn count_focus_links(input: &ShapleyInputIn, operator_focus: &str) -> usize {
    let focus_devices: std::collections::HashSet<&str> = input
        .devices
        .iter()
        .filter(|d| d.operator == operator_focus)
        .map(|d| d.device.as_str())
        .collect();
    input
        .private_links
        .iter()
        .filter(|l| {
            focus_devices.contains(l.device1.as_str()) || focus_devices.contains(l.device2.as_str())
        })
        .count()
}

/// Borrowed mirror of [`LinkEstimateRequest`] for hashing without cloning the
/// (potentially large) input. Field names AND order must match the owned struct
/// exactly so both serialize to the identical JSON string.
#[derive(serde::Serialize)]
struct LinkEstimateRequestRef<'a> {
    input: &'a ShapleyInputIn,
    operator_focus: &'a str,
}

/// The idempotency/S3 key for a link-estimate request: `queue::hash_payload`
/// over the canonical JSON of the full `LinkEstimateRequest` — IDENTICAL to the
/// hash `jobs::enqueue` stamps on the stream entry (`entry.input_hash`), so the
/// sync path, the submit short-circuit, the precompute sweep, and the worker
/// all address the same S3 object (`cache::S3Cache::link_estimate_key`).
pub(crate) fn link_estimate_payload_hash(input: &ShapleyInputIn, operator_focus: &str) -> u64 {
    let json = serde_json::to_string(&LinkEstimateRequestRef {
        input,
        operator_focus,
    })
    .unwrap_or_else(|e| {
        // Unreachable for plain structs; log rather than silently collapsing
        // every failure onto one cache key.
        tracing::error!(error = %e, "link_estimate_payload_hash: serialize failed");
        String::new()
    });
    crate::queue::hash_payload(&json)
}

/// Sets the compute's cancel flag when dropped. Held across the sync handler's
/// await so that the handler future being dropped — `TimeoutLayer` firing or
/// the client disconnecting — aborts the detached `spawn_blocking` solve at its
/// next coalition instead of letting it run to completion on the shared rayon
/// pool. (Dropping after a completed solve sets a flag nobody reads — harmless.)
struct CancelOnDrop(ComputeControl);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0
            .cancel
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Per-link Shapley value-add for a focus operator — a faithful port of the
/// Python `network_linkestimate`: retag each focus-owned link as its own
/// pseudo-operator, then run ONE exact 2^n coalition Shapley over the link-players
/// (single-shot over the whole demand set; NOT the per-city reward methodology).
///
/// Delegates to the engine's `ShapleyInput::network_link_estimate_cancellable`
/// (network-shapley-rs/src/link_estimate.rs), which reuses the warm-start
/// coalition solver. Synchronous path for SMALL requests only
/// ([`SYNC_MAX_FOCUS_LINKS`]); larger operators get a 422 directing them to
/// `POST /jobs/link-estimate`. The solve is cancelled if this request is
/// abandoned (timeout / client disconnect) via [`CancelOnDrop`].
///
/// Served from the S3 link-estimate cache when present — epoch inputs are
/// immutable, so a precomputed result is exact, not stale.
pub async fn link_estimate(
    State(state): State<Arc<crate::AppState>>,
    Json(body): Json<LinkEstimateRequest>,
) -> impl IntoResponse {
    if let Err(msg) = validate_dimensions(&body.input) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response();
    }

    let LinkEstimateRequest {
        input,
        operator_focus,
    } = body;

    // S3 read-through BEFORE the sync cap: a precomputed result for a large
    // operator is servable even though computing it inline would not be.
    let payload_hash = link_estimate_payload_hash(&input, &operator_focus);
    if let Some(s3) = &state.s3_cache
        && let Some(cached) = s3.load_link_estimate(payload_hash).await
    {
        tracing::info!(
            operator_focus,
            served_from = "s3",
            "link-estimate served from S3"
        );
        return Json(cached).into_response();
    }

    let focus_links = count_focus_links(&input, &operator_focus);
    if focus_links > SYNC_MAX_FOCUS_LINKS {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({
                "error": format!(
                    "operator_focus '{operator_focus}' owns {focus_links} links; the sync \
                     /link-estimate path caps at {SYNC_MAX_FOCUS_LINKS} (a 2^players coalition \
                     solve cannot finish within the request timeout) — use POST \
                     /jobs/link-estimate for progress and cancellation"
                )
            })),
        )
            .into_response();
    }

    let control = ComputeControl::default();
    let _cancel_guard = CancelOnDrop(control.clone());

    let start = std::time::Instant::now();
    match run_link_estimate(&input, &operator_focus, Some(control)).await {
        Ok(resp) => {
            tracing::info!(
                elapsed_ms = start.elapsed().as_millis() as u64,
                link_count = resp.links.len(),
                operator_focus,
                "link-estimate finished"
            );
            if let Some(s3) = &state.s3_cache {
                s3.store_link_estimate(payload_hash, &resp);
            }
            Json(resp).into_response()
        }
        Err(e) => {
            let (status, msg) = match e {
                // Reachable here only if cancel was set by some out-of-band
                // mechanism while the future was still polled; the usual
                // CancelOnDrop cancellation never resumes this handler.
                LinkEstimateError::Cancelled => (
                    StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST),
                    "link-estimate cancelled".to_string(),
                ),
                LinkEstimateError::Engine(err) => {
                    (StatusCode::UNPROCESSABLE_ENTITY, err.to_string())
                }
                LinkEstimateError::Panicked => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "link-estimate solver panicked".to_string(),
                ),
            };
            tracing::warn!(error = %msg, operator_focus, "link-estimate failed");
            (status, Json(serde_json::json!({ "error": msg }))).into_response()
        }
    }
}

/// Why a link-estimate run failed. The sync handler maps this to an HTTP
/// status; the async worker maps it to a queue `Outcome` — each edge owns its
/// own policy, the compute is shared.
pub(crate) enum LinkEstimateError {
    /// Cooperative cancellation (`control.cancel` set — request abandoned on
    /// the sync path, `DELETE /jobs/:id` on the async path).
    Cancelled,
    /// Input-deterministic engine failure (validation, too many link-players, …).
    Engine(network_shapley::error::ShapleyError),
    /// The blocking solve panicked (`JoinError`) — possibly transient.
    Panicked,
}

/// Run a single faithful link-estimate off the tokio thread. THE shared compute
/// core for both the sync handler above and the async worker
/// (`worker::run_link_estimate`); `control` drives progress + cancellation.
pub(crate) async fn run_link_estimate(
    input: &ShapleyInputIn,
    operator_focus: &str,
    control: Option<ComputeControl>,
) -> Result<LinkEstimateResponse, LinkEstimateError> {
    let engine_input = build_input(input);
    let focus = operator_focus.to_string();
    let joined = tokio::task::spawn_blocking(move || match control {
        Some(c) => engine_input.network_link_estimate_cancellable(&focus, &c),
        None => engine_input.network_link_estimate(&focus),
    })
    .await;

    match joined {
        Ok(Ok(links)) => Ok(LinkEstimateResponse {
            method: "retag-shapley-rs".to_string(),
            operator_focus: operator_focus.to_string(),
            links: links.into_iter().map(link_estimate_out).collect(),
        }),
        Ok(Err(network_shapley::error::ShapleyError::Cancelled)) => {
            Err(LinkEstimateError::Cancelled)
        }
        Ok(Err(e)) => Err(LinkEstimateError::Engine(e)),
        // spawn_blocking JoinError = a panic inside the solve. Surface it as a
        // typed error so each edge keeps its JSON/Outcome contract (no .expect:
        // a solver panic must not take the handler down with it).
        Err(_) => Err(LinkEstimateError::Panicked),
    }
}

/// Map the crate's `LinkEstimate` onto the wire `LinkEstimateOut` (1:1).
pub(crate) fn link_estimate_out(
    l: network_shapley::link_estimate::LinkEstimate,
) -> LinkEstimateOut {
    LinkEstimateOut {
        device1: l.device1,
        device2: l.device2,
        bandwidth: l.bandwidth,
        latency: l.latency,
        value: l.value,
        percent: l.percent,
    }
}

// ── Async job API (start / poll / cancel) ───────────────────────────────

/// `POST /jobs/simulate`: enqueue a what-if simulation as a background job.
///
/// Returns `202 { job_id }` immediately; the heavy solve runs on the worker
/// pool (ADR 0001 Phase 2), so this handler only validates, persists the
/// request payload, and `XADD`s a tiny entry onto the Redis work Stream. The
/// client polls `GET /jobs/{id}` for progress + result, or `DELETE /jobs/{id}`
/// to cancel — both work from any replica because all state lives in Redis.
pub async fn simulate_start(
    State(state): State<Arc<crate::AppState>>,
    Json(body): Json<SimulateRequest>,
) -> impl IntoResponse {
    if let Err(msg) = validate_dimensions(&body.baseline) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": format!("baseline: {msg}") })),
        )
            .into_response();
    }
    if let Err(msg) = validate_dimensions(&body.modified) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": format!("modified: {msg}") })),
        )
            .into_response();
    }

    let Some(store) = state.jobs.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "async jobs disabled (REDIS_URL not configured)" })),
        )
            .into_response();
    };

    // Mint the job (state=running) so a poll right after the 202 already sees
    // it, then enqueue the payload + stream entry for a worker to consume.
    let job_id = match store.create().await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(error = %e, "failed to create job");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "job store unavailable" })),
            )
                .into_response();
        }
    };

    match store
        .enqueue(&job_id, crate::queue::JobKind::Simulate, &body)
        .await
    {
        Ok(input_hash) => {
            tracing::info!(job_id, input_hash, "what-if job enqueued");
            (
                StatusCode::ACCEPTED,
                Json(serde_json::json!({ "job_id": job_id })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, job_id, "enqueue failed");
            // Best-effort: surface the failure on the next poll.
            let _ = store.set_failed(&job_id, "enqueue failed").await;
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "enqueue failed" })),
            )
                .into_response()
        }
    }
}

/// `POST /jobs/link-estimate`: enqueue a per-link value-add as a background job.
///
/// Same lifecycle as [`simulate_start`] (202 + `job_id`, then poll `GET /jobs/{id}`
/// / `DELETE /jobs/{id}`), for the faithful retag-Shapley link-estimate. Large
/// focus operators (up to the 20-link cap → `2^20` coalitions) get progress +
/// cancellation here instead of blocking the sync `/link-estimate`.
pub async fn link_estimate_start(
    State(state): State<Arc<crate::AppState>>,
    Json(body): Json<LinkEstimateRequest>,
) -> impl IntoResponse {
    if let Err(msg) = validate_dimensions(&body.input) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response();
    }

    let Some(store) = state.jobs.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "async jobs disabled (REDIS_URL not configured)" })),
        )
            .into_response();
    };

    let payload_hash = link_estimate_payload_hash(&body.input, &body.operator_focus);
    let hash_hex = format!("{payload_hash:016x}");

    // In-flight dedup, attach path: an identical solve already running (e.g. a
    // sweep child) → return ITS job_id instead of enqueueing a duplicate
    // multi-minute solve. Best-effort: any Redis hiccup here falls through to
    // the normal enqueue (dedup is an optimization, never a gate). A claim
    // whose job state has vanished is stale (crashed worker) — clear it.
    match store.get_inflight(&hash_hex).await {
        Ok(Some(existing)) => {
            if matches!(store.snapshot(&existing).await, Ok(Some(_))) {
                tracing::info!(job_id = %existing, operator_focus = %body.operator_focus,
                    "link-estimate already in flight — attaching");
                return (
                    StatusCode::ACCEPTED,
                    Json(serde_json::json!({ "job_id": existing })),
                )
                    .into_response();
            }
            let _ = store.clear_inflight(&hash_hex).await;
        }
        Ok(None) => {}
        Err(e) => tracing::warn!(error = %e, "inflight lookup failed — proceeding without dedup"),
    }

    let job_id = match store.create().await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(error = %e, "failed to create job");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "job store unavailable" })),
            )
                .into_response();
        }
    };

    // S3 short-circuit: a precomputed result (epoch sweep) completes the job at
    // submit time, so the client's first poll returns done — UI requests never
    // queue behind a sweep's worth of solves.
    if let Some(s3) = &state.s3_cache
        && let Some(cached) = s3.load_link_estimate(payload_hash).await
    {
        match serde_json::to_value(&cached) {
            Ok(v) => {
                if let Err(e) = store.set_done(&job_id, &v).await {
                    tracing::error!(error = %e, job_id, "set_done from S3 failed");
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": "job store unavailable" })),
                    )
                        .into_response();
                }
                tracing::info!(job_id, operator_focus = %body.operator_focus,
                    served_from = "s3", "link-estimate job completed from S3");
                return (
                    StatusCode::ACCEPTED,
                    Json(serde_json::json!({ "job_id": job_id })),
                )
                    .into_response();
            }
            Err(e) => {
                // Unreachable for plain structs; fall through to a real solve
                // rather than serving nothing.
                tracing::error!(error = %e, "cached link-estimate failed to re-serialize");
            }
        }
    }

    // In-flight dedup, claim path (the get_inflight above raced): claim the
    // hash for THIS job; lose ⇒ attach to the winner. The worker clears the
    // claim on terminal states; the key TTL is only the crash backstop.
    match store.try_claim_inflight(&hash_hex, &job_id).await {
        Ok(true) => {}
        Ok(false) => {
            if let Ok(Some(existing)) = store.get_inflight(&hash_hex).await
                && existing != job_id
                && matches!(store.snapshot(&existing).await, Ok(Some(_)))
            {
                // Tidy the never-exposed job we minted, then attach.
                let _ = store
                    .set_failed(&job_id, "superseded: identical solve already in flight")
                    .await;
                tracing::info!(job_id = %existing, operator_focus = %body.operator_focus,
                    "lost inflight race — attaching to winner");
                return (
                    StatusCode::ACCEPTED,
                    Json(serde_json::json!({ "job_id": existing })),
                )
                    .into_response();
            }
            // Winner vanished between SET NX and the lookup — proceed; worst
            // case is the pre-dedup behavior (a duplicate solve), never a miss.
        }
        Err(e) => tracing::warn!(error = %e, "inflight claim failed — proceeding without dedup"),
    }

    match store
        .enqueue(&job_id, crate::queue::JobKind::LinkEstimate, &body)
        .await
    {
        Ok(input_hash) => {
            tracing::info!(job_id, input_hash, operator_focus = %body.operator_focus,
                "link-estimate job enqueued");
            (
                StatusCode::ACCEPTED,
                Json(serde_json::json!({ "job_id": job_id })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, job_id, "enqueue failed");
            let _ = store.clear_inflight(&hash_hex).await;
            let _ = store.set_failed(&job_id, "enqueue failed").await;
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "enqueue failed" })),
            )
                .into_response()
        }
    }
}

/// Max focus links the sweep will enqueue: players = links + "Others" and the
/// engine's exact path caps at 20 players, so >19 links can NEVER be solved
/// exactly. Reported loudly in the sweep summary's `skipped` list rather than
/// enqueued as a guaranteed-to-fail job every epoch.
pub(crate) const SWEEP_MAX_FOCUS_LINKS: usize = 19;

/// `POST /precompute/link-estimates` request: the epoch's Shapley input plus an
/// optional explicit operator list (defaults to every device operator) and an
/// opaque `tag` keying the S3 "fully swept" marker (see the status endpoint).
///
/// NOTE: the marker is only ever written when `operators` is OMITTED (the
/// service derives the complete set) — an explicit list may be partial, and a
/// partial sweep must never mark the epoch fully swept.
#[derive(Debug, serde::Deserialize)]
pub struct LinkEstimateSweepRequest {
    pub input: ShapleyInputIn,
    #[serde(default)]
    pub operators: Option<Vec<String>>,
    #[serde(default)]
    pub tag: Option<String>,
}

/// `POST /precompute/link-estimates`: enqueue ONE sweep job for this
/// (immutable) epoch input — the epoch-cron warm-up — and return
/// `202 {job_id}` immediately. A worker expands the sweep into per-operator
/// link-estimate children (S3-cached operators skipped, in-flight duplicates
/// attached, link-count caps enforced) and writes the
/// `{enqueued, cached, skipped, already_running, failed}` summary as the sweep
/// job's `done` result — poll `GET /jobs/{job_id}` for it.
///
/// The handler itself does NO per-operator work: the old synchronous expansion
/// did O(operators) sequential S3 GETs + full-payload Redis writes on the open
/// socket, which the platform's edge router cut at ~30s with invisible partial state. The
/// epoch input is persisted ONCE (24h TTL) and shared by every child.
pub async fn link_estimate_sweep(
    State(state): State<Arc<crate::AppState>>,
    Json(body): Json<LinkEstimateSweepRequest>,
) -> impl IntoResponse {
    if let Err(msg) = validate_dimensions(&body.input) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response();
    }

    // A sweep without the queue is meaningless (its entire job is enqueueing
    // children) — fail loud up front. The all-cached fast path lives behind the
    // status endpoint's marker check, not here.
    let Some(store) = state.jobs.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "async jobs disabled (REDIS_URL not configured) — sweep requires the job queue",
            })),
        )
            .into_response();
    };

    let derived_operators = body.operators.is_none();
    let operators: Vec<String> = match body.operators {
        Some(ops) => ops,
        None => {
            let mut ops: Vec<String> = body
                .input
                .devices
                .iter()
                .map(|d| d.operator.clone())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            ops.sort();
            ops
        }
    };

    let job_id = match store.create().await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(error = %e, "sweep: failed to create job");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "job store unavailable" })),
            )
                .into_response();
        }
    };

    let payload = SweepPayload {
        input: body.input,
        operators,
        derived_operators,
        tag: body.tag,
    };
    // Store the epoch input ONCE with the long sweep TTL (children reference
    // it; the worker refreshes it on every child pickup), then XADD the single
    // tiny sweep entry.
    let result = match store
        .store_payload(
            &crate::queue::payload_key(&job_id),
            &payload,
            crate::queue::SWEEP_PAYLOAD_TTL_SECS,
        )
        .await
    {
        Ok(input_hash) => {
            store
                .enqueue_ref(&job_id, crate::queue::JobKind::Sweep, &input_hash)
                .await
        }
        Err(e) => Err(e),
    };

    match result {
        Ok(()) => {
            tracing::info!(job_id, operators = payload.operators.len(), tag = ?payload.tag,
                "sweep job enqueued");
            (
                StatusCode::ACCEPTED,
                Json(serde_json::json!({ "job_id": job_id })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, job_id, "sweep: enqueue failed");
            let _ = store.set_failed(&job_id, "enqueue failed").await;
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "enqueue failed" })),
            )
                .into_response()
        }
    }
}

/// `GET /precompute/link-estimates/status?tag=...`: whether the "fully swept"
/// S3 marker exists for this tag. The cron route checks this FIRST and skips
/// the (70MB) snapshot fetch + canonical build entirely when the epoch is
/// already swept — the steady-state cron fire costs one HEAD request.
pub async fn link_estimate_sweep_status(
    State(state): State<Arc<crate::AppState>>,
    Query(query): Query<SweepStatusQuery>,
) -> impl IntoResponse {
    let complete = match &state.s3_cache {
        Some(s3) => s3.load_sweep_marker(&query.tag).await,
        // No S3 ⇒ no markers can exist; report incomplete so the caller
        // proceeds with a real sweep (which is the correct behavior).
        None => false,
    };
    Json(serde_json::json!({ "complete": complete, "tag": query.tag }))
}

/// Query for [`link_estimate_sweep_status`].
#[derive(Debug, serde::Deserialize)]
pub struct SweepStatusQuery {
    pub tag: String,
}

/// `GET /jobs/{id}`: poll status + progress (and the result when done).
pub async fn job_status(
    State(state): State<Arc<crate::AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(store) = state.jobs.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "async jobs disabled" })),
        )
            .into_response();
    };
    match store.snapshot(&id).await {
        Ok(Some(v)) => Json(v).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "job not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "job snapshot failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "job store unavailable" })),
            )
                .into_response()
        }
    }
}

/// `DELETE /jobs/{id}`: request cancellation. A finished job is unaffected; a
/// running job transitions to `cancelled` within ~one batch.
pub async fn job_cancel(
    State(state): State<Arc<crate::AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(store) = state.jobs.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "async jobs disabled" })),
        )
            .into_response();
    };
    match store.request_cancel(&id).await {
        Ok(true) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "state": "cancelling" })),
        )
            .into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "job not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "job cancel failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "job store unavailable" })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DemandIn, DeviceIn, PrivateLinkIn, PublicLinkIn, ShapleyInputIn};

    /// DIAGNOSTIC CAPTURE (`#[ignore]`): dump the per-source-city raw Shapley
    /// value matrix `V[city] -> [(operator, value)]` for the epoch-149 fixture,
    /// plus our aggregated proportions, so the ~8.6% reward-leaf divergence can
    /// be analysed INSTANTLY (re-aggregate with different weights, fit weights to
    /// the chain leaves) without re-running the ~24-min per-city exact solve.
    /// Reuses the real reward path (`compute_per_city`, EXACT). Run with:
    ///   cargo test --lib routes::tests::capture_per_city_values_epoch149 \
    ///     -- --ignored --nocapture
    #[test]
    #[ignore = "heavy: full epoch-149 per-city exact solve (~24 min); diagnostic capture"]
    fn capture_per_city_values_epoch149() {
        let dir =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/epoch149");
        let input: ShapleyInputIn =
            serde_json::from_str(&std::fs::read_to_string(dir.join("input.json")).unwrap())
                .expect("deserialize input.json");

        let reuse: std::collections::BTreeMap<String, CityValues> =
            std::collections::BTreeMap::new();
        let result = compute_per_city(&input, &reuse, None)
            .unwrap_or_else(|e| panic!("compute_per_city failed: {}", e.message()));

        // V[city] -> [(operator, raw shapley value)] — the expensive invariant.
        std::fs::write(
            dir.join("per_city_values.json"),
            serde_json::to_string_pretty(&result.per_city).unwrap(),
        )
        .unwrap();
        // Self-check: our aggregated proportions (operator -> share), so the
        // analyzer can confirm it reproduces the live run's numbers exactly.
        let props: std::collections::BTreeMap<String, f64> = result
            .aggregated
            .iter()
            .map(|(op, o)| (op.clone(), o.share))
            .collect();
        std::fs::write(
            dir.join("our_proportions.json"),
            serde_json::to_string_pretty(&props).unwrap(),
        )
        .unwrap();
        eprintln!(
            "captured V: {} cities, {} operators, method={}",
            result.per_city.len(),
            result.aggregated.len(),
            result.method,
        );
    }

    /// Helper: build a valid `ShapleyInputIn` with per-operator device names
    /// matching the DZ canonical format (`{METRO}{N}`).
    /// The S3 key contract: the borrowed-ref hash (sync path / sweep) must equal
    /// the hash `jobs::enqueue` computes from the OWNED `LinkEstimateRequest`
    /// (`serde_json::to_string(&req)` → `queue::hash_payload`) — otherwise the
    /// paths would address different S3 objects and read-through would never hit.
    #[test]
    fn link_estimate_payload_hash_matches_enqueue_hash() {
        let input = canonical_input();
        let req = crate::model::LinkEstimateRequest {
            input: input.clone(),
            operator_focus: "Alpha".into(),
        };
        let owned_json = serde_json::to_string(&req).expect("serialize");
        assert_eq!(
            link_estimate_payload_hash(&input, "Alpha"),
            crate::queue::hash_payload(&owned_json),
        );
        // And a different focus keys a different object.
        assert_ne!(
            link_estimate_payload_hash(&input, "Alpha"),
            link_estimate_payload_hash(&input, "Beta"),
        );
    }

    fn canonical_input() -> ShapleyInputIn {
        ShapleyInputIn {
            devices: vec![
                DeviceIn {
                    device: "FRA1".into(),
                    edge: 1,
                    operator: "Alpha".into(),
                },
                DeviceIn {
                    device: "FRA2".into(),
                    edge: 0,
                    operator: "Beta".into(),
                },
                DeviceIn {
                    device: "AMS1".into(),
                    edge: 1,
                    operator: "Alpha".into(),
                },
                DeviceIn {
                    device: "AMS2".into(),
                    edge: 0,
                    operator: "Beta".into(),
                },
            ],
            private_links: vec![
                PrivateLinkIn {
                    device1: "FRA1".into(),
                    device2: "AMS1".into(),
                    latency: 5.0,
                    bandwidth: 10.0,
                    uptime: 0.99,
                    shared: None,
                },
                PrivateLinkIn {
                    device1: "FRA2".into(),
                    device2: "AMS2".into(),
                    latency: 6.0,
                    bandwidth: 10.0,
                    uptime: 0.99,
                    shared: None,
                },
            ],
            public_links: vec![PublicLinkIn {
                city1: "FRA".into(),
                city2: "AMS".into(),
                latency: 7.0,
            }],
            demands: vec![DemandIn {
                start: "FRA".into(),
                end: "AMS".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 1.0,
                kind: 1,
                multicast: false,
            }],
            operator_uptime: 0.98,
            contiguity_bonus: 5.0,
            demand_multiplier: 1.0,
            city_weights: Default::default(),
        }
    }

    #[test]
    fn unique_per_operator_devices_pass_through() {
        let input = canonical_input();
        let built = build_input(&input);

        // All 4 devices should be preserved — no dedup
        assert_eq!(
            built.devices.len(),
            4,
            "unique device names must all pass through"
        );

        // Verify operator assignments are correct
        let fra1 = built.devices.iter().find(|d| d.device == "FRA1").unwrap();
        assert_eq!(fra1.operator, "Alpha");
        assert_eq!(fra1.edge, 1);

        let fra2 = built.devices.iter().find(|d| d.device == "FRA2").unwrap();
        assert_eq!(fra2.operator, "Beta");
        assert_eq!(fra2.edge, 0);
    }

    #[test]
    fn validate_dimensions_caps_operator_count() {
        // Minimal input with `n` distinct operators (one device each); empty
        // links/demands trivially pass the other dimension checks.
        fn input_with_operators(n: usize) -> ShapleyInputIn {
            ShapleyInputIn {
                devices: (0..n)
                    .map(|i| DeviceIn {
                        device: format!("DEV{i}"),
                        edge: 1,
                        operator: format!("op{i}"),
                    })
                    .collect(),
                private_links: vec![],
                public_links: vec![],
                demands: vec![],
                operator_uptime: 0.98,
                contiguity_bonus: 5.0,
                demand_multiplier: 1.0,
                city_weights: Default::default(),
            }
        }
        // Exactly at the cap is accepted (the engine's exact-solve ceiling).
        assert!(validate_dimensions(&input_with_operators(MAX_OPERATORS)).is_ok());
        // One over the cap is rejected before any allocation, with an
        // operator-count message.
        let err = validate_dimensions(&input_with_operators(MAX_OPERATORS + 1))
            .expect_err("over-cap operator count must be rejected");
        assert!(err.contains("operator count"), "unexpected message: {err}");
    }

    #[test]
    fn private_links_reference_device_names() {
        let input = canonical_input();
        let built = build_input(&input);

        // Links should reference FRA1↔AMS1, not bare FRA↔AMS
        assert_eq!(built.private_links.len(), 2);
        assert_eq!(built.private_links[0].device1, "FRA1");
        assert_eq!(built.private_links[0].device2, "AMS1");
        assert_eq!(built.private_links[1].device1, "FRA2");
        assert_eq!(built.private_links[1].device2, "AMS2");
    }

    #[test]
    fn public_links_use_city_codes() {
        let input = canonical_input();
        let built = build_input(&input);

        // Public links stay at the city-code level
        assert_eq!(built.public_links.len(), 1);
        assert_eq!(built.public_links[0].city1, "FRA");
        assert_eq!(built.public_links[0].city2, "AMS");
    }

    #[test]
    fn shapley_computes_with_canonical_input() {
        let input = canonical_input();
        let built = build_input(&input);
        let result = built.compute();

        // The LP should succeed with properly-named devices
        assert!(
            result.is_ok(),
            "Shapley compute must succeed: {:?}",
            result.err()
        );
        let output = result.unwrap();

        // Both operators should appear in the output
        assert!(output.contains_key("Alpha"), "Alpha must be in output");
        assert!(output.contains_key("Beta"), "Beta must be in output");

        // Both should have non-degenerate shares
        let alpha = output.get("Alpha").unwrap();
        let beta = output.get("Beta").unwrap();
        assert!(
            alpha.proportion > 0.0,
            "Alpha share must be > 0, got {}",
            alpha.proportion
        );
        assert!(
            beta.proportion > 0.0,
            "Beta share must be > 0, got {}",
            beta.proportion
        );
        assert!(
            (alpha.proportion + beta.proportion - 1.0).abs() < 1e-6,
            "shares must sum to ~1.0, got {}",
            alpha.proportion + beta.proportion
        );
    }

    #[test]
    fn single_operator_gets_full_share() {
        let input = ShapleyInputIn {
            devices: vec![
                DeviceIn {
                    device: "FRA1".into(),
                    edge: 1,
                    operator: "Solo".into(),
                },
                DeviceIn {
                    device: "AMS1".into(),
                    edge: 1,
                    operator: "Solo".into(),
                },
            ],
            private_links: vec![PrivateLinkIn {
                device1: "FRA1".into(),
                device2: "AMS1".into(),
                latency: 5.0,
                bandwidth: 10.0,
                uptime: 0.99,
                shared: None,
            }],
            public_links: vec![PublicLinkIn {
                city1: "FRA".into(),
                city2: "AMS".into(),
                latency: 7.0,
            }],
            demands: vec![DemandIn {
                start: "FRA".into(),
                end: "AMS".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 1.0,
                kind: 1,
                multicast: false,
            }],
            operator_uptime: 0.98,
            contiguity_bonus: 5.0,
            demand_multiplier: 1.0,
            city_weights: Default::default(),
        };

        let built = build_input(&input);
        let result = built.compute().expect("compute must succeed");
        let solo = result.get("Solo").expect("Solo must be in output");
        assert!(
            (solo.proportion - 1.0).abs() < 1e-6,
            "single operator should have ~100% share, got {}",
            solo.proportion
        );
    }

    /// Regression test: clients may send flat type IDs (type=1 for all
    /// IBRL demands) with multiple source cities.  Without normalisation
    /// the upstream crate rejects this with "Data inconsistency".
    /// `build_input` must reassign types so compute succeeds.
    #[test]
    fn flat_type_ids_with_multiple_sources_are_normalised() {
        let input = ShapleyInputIn {
            devices: vec![
                DeviceIn {
                    device: "FRA1".into(),
                    edge: 1,
                    operator: "Alpha".into(),
                },
                DeviceIn {
                    device: "AMS1".into(),
                    edge: 1,
                    operator: "Beta".into(),
                },
                DeviceIn {
                    device: "TYO1".into(),
                    edge: 1,
                    operator: "Gamma".into(),
                },
            ],
            private_links: vec![
                PrivateLinkIn {
                    device1: "FRA1".into(),
                    device2: "AMS1".into(),
                    latency: 5.0,
                    bandwidth: 10.0,
                    uptime: 0.99,
                    shared: None,
                },
                PrivateLinkIn {
                    device1: "AMS1".into(),
                    device2: "TYO1".into(),
                    latency: 80.0,
                    bandwidth: 10.0,
                    uptime: 0.99,
                    shared: None,
                },
                PrivateLinkIn {
                    device1: "FRA1".into(),
                    device2: "TYO1".into(),
                    latency: 60.0,
                    bandwidth: 10.0,
                    uptime: 0.99,
                    shared: None,
                },
            ],
            public_links: vec![
                PublicLinkIn {
                    city1: "FRA".into(),
                    city2: "AMS".into(),
                    latency: 7.0,
                },
                PublicLinkIn {
                    city1: "AMS".into(),
                    city2: "TYO".into(),
                    latency: 7.0,
                },
                PublicLinkIn {
                    city1: "FRA".into(),
                    city2: "TYO".into(),
                    latency: 7.0,
                },
            ],
            // All demands share type=1 despite different starts — the bug
            demands: vec![
                DemandIn {
                    start: "FRA".into(),
                    end: "AMS".into(),
                    receivers: 5,
                    traffic: 0.15,
                    priority: 0.0,
                    kind: 1,
                    multicast: false,
                },
                DemandIn {
                    start: "FRA".into(),
                    end: "TYO".into(),
                    receivers: 5,
                    traffic: 0.15,
                    priority: 0.0,
                    kind: 1,
                    multicast: false,
                },
                DemandIn {
                    start: "AMS".into(),
                    end: "FRA".into(),
                    receivers: 5,
                    traffic: 0.15,
                    priority: 0.0,
                    kind: 1,
                    multicast: false,
                },
                DemandIn {
                    start: "AMS".into(),
                    end: "TYO".into(),
                    receivers: 5,
                    traffic: 0.15,
                    priority: 0.0,
                    kind: 1,
                    multicast: false,
                },
                DemandIn {
                    start: "TYO".into(),
                    end: "FRA".into(),
                    receivers: 5,
                    traffic: 0.15,
                    priority: 0.0,
                    kind: 1,
                    multicast: false,
                },
                DemandIn {
                    start: "TYO".into(),
                    end: "AMS".into(),
                    receivers: 5,
                    traffic: 0.15,
                    priority: 0.0,
                    kind: 1,
                    multicast: false,
                },
            ],
            operator_uptime: 0.98,
            contiguity_bonus: 5.0,
            demand_multiplier: 1.0,
            city_weights: Default::default(),
        };

        let built = build_input(&input);

        // Must succeed — without normalisation this panics / returns Err.
        let result = built.compute();
        assert!(
            result.is_ok(),
            "compute must succeed after normalisation: {:?}",
            result.err()
        );

        let output = result.unwrap();
        assert_eq!(output.len(), 3, "all 3 operators must appear");

        // In a fully symmetric network the LP may assign zero marginal
        // value to every operator — the important assertion is that
        // compute() didn't reject the input with DataInconsistency.
        let total: f64 = output.values().map(|v| v.proportion).sum();
        assert!(total >= 0.0, "shares must be non-negative, got {}", total);
    }

    /// Verify that normalisation preserves commodity semantics:
    /// same (start, multicast, priority) → same type,
    /// different start → different type.
    #[test]
    fn normalisation_groups_by_start_multicast_priority() {
        let input = ShapleyInputIn {
            devices: vec![
                DeviceIn {
                    device: "FRA1".into(),
                    edge: 1,
                    operator: "A".into(),
                },
                DeviceIn {
                    device: "AMS1".into(),
                    edge: 1,
                    operator: "B".into(),
                },
            ],
            private_links: vec![PrivateLinkIn {
                device1: "FRA1".into(),
                device2: "AMS1".into(),
                latency: 5.0,
                bandwidth: 10.0,
                uptime: 0.99,
                shared: None,
            }],
            public_links: vec![PublicLinkIn {
                city1: "FRA".into(),
                city2: "AMS".into(),
                latency: 7.0,
            }],
            demands: vec![
                // Two demands from FRA, same priority/multicast → should share a type
                DemandIn {
                    start: "FRA".into(),
                    end: "AMS".into(),
                    receivers: 1,
                    traffic: 1.0,
                    priority: 0.0,
                    kind: 99,
                    multicast: false,
                },
                DemandIn {
                    start: "FRA".into(),
                    end: "AMS".into(),
                    receivers: 2,
                    traffic: 0.5,
                    priority: 0.0,
                    kind: 99,
                    multicast: false,
                },
                // One demand from AMS → different type
                DemandIn {
                    start: "AMS".into(),
                    end: "FRA".into(),
                    receivers: 1,
                    traffic: 1.0,
                    priority: 0.0,
                    kind: 99,
                    multicast: false,
                },
                // One demand from FRA but multicast → different type
                DemandIn {
                    start: "FRA".into(),
                    end: "AMS".into(),
                    receivers: 1,
                    traffic: 1.0,
                    priority: 0.0,
                    kind: 99,
                    multicast: true,
                },
            ],
            operator_uptime: 0.98,
            contiguity_bonus: 5.0,
            demand_multiplier: 1.0,
            city_weights: Default::default(),
        };

        let built = build_input(&input);

        // Demands 0 and 1 (FRA, unicast, prio=0) should share a type
        assert_eq!(
            built.demands[0].kind, built.demands[1].kind,
            "same (start, multicast, priority) must share type"
        );

        // Demand 2 (AMS, unicast, prio=0) should differ
        assert_ne!(
            built.demands[0].kind, built.demands[2].kind,
            "different start must get different type"
        );

        // Demand 3 (FRA, multicast, prio=0) should differ from demand 0
        assert_ne!(
            built.demands[0].kind, built.demands[3].kind,
            "different multicast flag must get different type"
        );
    }

    // ── Per-city compute + stake-weighted aggregation (DZ parity) ───────────

    /// End-to-end: a two-city canonical input runs per-city EXACT and aggregates.
    /// Both Alpha and Beta should appear with shares summing to ~1.0.
    #[test]
    fn compute_per_city_aggregates_two_cities() {
        let mut input = canonical_input();
        // Equal stake share for the two source cities (FRA, AMS).
        input.city_weights = [("FRA".to_string(), 0.5), ("AMS".to_string(), 0.5)]
            .into_iter()
            .collect();
        // Demands originate from both FRA and AMS so there are two source cities.
        input.demands = vec![
            DemandIn {
                start: "FRA".into(),
                end: "AMS".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 0.0,
                kind: 1,
                multicast: false,
            },
            DemandIn {
                start: "AMS".into(),
                end: "FRA".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 0.0,
                kind: 1,
                multicast: false,
            },
        ];

        let result = compute_per_city(&input, &BTreeMap::new(), None)
            .unwrap_or_else(|e| panic!("compute_per_city failed: {}", e.message()));

        assert_eq!(result.method, "lp-per-city-stake-weighted-exact");
        assert_eq!(result.cities_solved, 2);
        assert_eq!(result.cities_reused, 0);
        assert!(result.per_city.contains_key("FRA"));
        assert!(result.per_city.contains_key("AMS"));
        // Shares sum to ~1.0 unless the LP is fully symmetric (every marginal
        // value 0 → total 0 → all shares 0). Both are valid; assert one holds.
        let total: f64 = result.aggregated.values().map(|v| v.share).sum();
        assert!(
            (total - 1.0).abs() < 1e-9 || total.abs() < 1e-9,
            "shares should sum to ~1.0 (or ~0 when degenerate), got {total}"
        );
    }

    /// The per-city reward path reports COALITION-level progress aggregated across
    /// the parallel cities: `coalitions_solved` reaches `cities × 2^operators`, the
    /// denominator (`batch_total`) matches, and a reused (B3) city still counts its
    /// full coalition share. Guards the smooth-progress-bar wiring.
    #[test]
    fn compute_per_city_reports_coalition_progress() {
        use std::sync::atomic::Ordering;

        let mut input = canonical_input();
        input.city_weights = [("FRA".to_string(), 0.5), ("AMS".to_string(), 0.5)]
            .into_iter()
            .collect();
        input.demands = vec![
            DemandIn {
                start: "FRA".into(),
                end: "AMS".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 0.0,
                kind: 1,
                multicast: false,
            },
            DemandIn {
                start: "AMS".into(),
                end: "FRA".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 0.0,
                kind: 1,
                multicast: false,
            },
        ];

        // Denominator = (source cities) × 2^operators, same as compute_per_city.
        let total_coalitions = 2 * build_input(&input).coalition_count();

        // Full solve: the engine increments per coalition across both parallel cities.
        let ctrl = ComputeControl::default();
        compute_per_city(&input, &BTreeMap::new(), Some(&ctrl))
            .unwrap_or_else(|e| panic!("compute_per_city failed: {}", e.message()));
        assert_eq!(
            ctrl.progress.coalitions_solved.load(Ordering::Relaxed),
            total_coalitions,
            "coalitions_solved must reach cities × 2^operators"
        );
        assert_eq!(
            ctrl.progress.batch_total.load(Ordering::Relaxed),
            total_coalitions,
            "batch_total is the bar denominator"
        );
        assert_eq!(
            ctrl.progress.batch_solved.load(Ordering::Relaxed),
            total_coalitions,
            "batch_solved (numerator) reaches the denominator at completion"
        );

        // Reuse both cities from a baseline: no engine solve runs, but each reused
        // city must still bump its full coalition share so the bar reaches 100%.
        let baseline = compute_per_city(&input, &BTreeMap::new(), None)
            .unwrap_or_else(|e| panic!("baseline failed: {}", e.message()));
        let reuse: BTreeMap<String, CityValues> = baseline.per_city.clone();
        let ctrl_reuse = ComputeControl::default();
        let reused = compute_per_city(&input, &reuse, Some(&ctrl_reuse))
            .unwrap_or_else(|e| panic!("reuse failed: {}", e.message()));
        assert_eq!(reused.cities_reused, 2, "both cities reused");
        assert_eq!(
            ctrl_reuse
                .progress
                .coalitions_solved
                .load(Ordering::Relaxed),
            total_coalitions,
            "reused cities must still count their coalition share"
        );
    }

    // ── aggregate_per_city — direct ports of DZ aggregator.rs unit tests ────
    // These pin our aggregation to DoubleZero's exactly (contributor-rewards/
    // v0.5.3 calculator/shapley/aggregator.rs).

    /// Port of DZ `test_fra_nyc_weighted_aggregation`: FRA weight 0.6, NYC 0.4.
    /// OperatorA = 100*0.6 + 80*0.4 = 92; B = 50*0.6 = 30; C = 70*0.4 = 28.
    #[test]
    fn aggregate_matches_dz_fra_nyc() {
        let per_city: BTreeMap<String, Vec<(String, f64)>> = [
            (
                "FRA".to_string(),
                vec![
                    ("OperatorA".to_string(), 100.0),
                    ("OperatorB".to_string(), 50.0),
                ],
            ),
            (
                "NYC".to_string(),
                vec![
                    ("OperatorA".to_string(), 80.0),
                    ("OperatorC".to_string(), 70.0),
                ],
            ),
        ]
        .into_iter()
        .collect();
        // calculate_city_weights(stake FRA=600, NYC=400) → 0.6 / 0.4.
        let weights: BTreeMap<String, f64> = [("FRA".to_string(), 0.6), ("NYC".to_string(), 0.4)]
            .into_iter()
            .collect();

        let out = aggregate_per_city(&per_city, &weights);
        assert!((out["OperatorA"].value - 92.0).abs() < 1e-9);
        assert!((out["OperatorA"].share - 92.0 / 150.0).abs() < 1e-9);
        assert!((out["OperatorB"].value - 30.0).abs() < 1e-9);
        assert!((out["OperatorB"].share - 30.0 / 150.0).abs() < 1e-9);
        assert!((out["OperatorC"].value - 28.0).abs() < 1e-9);
        assert!((out["OperatorC"].share - 28.0 / 150.0).abs() < 1e-9);
    }

    /// Port of DZ `test_negative_values_passthrough`: raw shares, no clamp.
    /// HEL weight 1.0; Pos=100, Neg=-50; total=50 → Pos share 2.0, Neg share -1.0.
    #[test]
    fn aggregate_matches_dz_negative_passthrough() {
        let per_city: BTreeMap<String, Vec<(String, f64)>> = [(
            "HEL".to_string(),
            vec![
                ("OpPositive".to_string(), 100.0),
                ("OpNegative".to_string(), -50.0),
            ],
        )]
        .into_iter()
        .collect();
        let weights: BTreeMap<String, f64> = [("HEL".to_string(), 1.0)].into_iter().collect();

        let out = aggregate_per_city(&per_city, &weights);
        assert!((out["OpPositive"].value - 100.0).abs() < 1e-9);
        assert!((out["OpPositive"].share - 2.0).abs() < 1e-9); // 100/50
        assert!((out["OpNegative"].value + 50.0).abs() < 1e-9);
        assert!((out["OpNegative"].share + 1.0).abs() < 1e-9); // -50/50
    }

    /// Port of DZ `test_zero_price_city`: a zero-weight city is fully ignored.
    #[test]
    fn aggregate_matches_dz_zero_weight_skip() {
        let per_city: BTreeMap<String, Vec<(String, f64)>> = [
            ("MAD".to_string(), vec![("OpIgnored".to_string(), 999.0)]),
            ("ROM".to_string(), vec![("OpActive".to_string(), 50.0)]),
        ]
        .into_iter()
        .collect();
        // MAD has zero stake → weight 0; ROM has all the stake → weight 1.
        let weights: BTreeMap<String, f64> = [("MAD".to_string(), 0.0), ("ROM".to_string(), 1.0)]
            .into_iter()
            .collect();

        let out = aggregate_per_city(&per_city, &weights);
        assert_eq!(out.len(), 1, "zero-weight city's operator must be dropped");
        assert!((out["OpActive"].value - 50.0).abs() < 1e-9);
        assert!((out["OpActive"].share - 1.0).abs() < 1e-9);
    }

    /// Non-canonical input (no city_weights) must ERROR on the reward path —
    /// never silently fall back to a monolithic solve.
    #[test]
    fn compute_per_city_rejects_missing_city_weights() {
        let input = canonical_input(); // canonical_input() has empty city_weights
        let err = compute_per_city(&input, &BTreeMap::new(), None)
            .err()
            .expect("must reject input with no city_weights");
        assert!(!matches!(err, PerCityError::Cancelled));
        assert!(err.message().contains("city_weights"));
    }

    /// A zero-weight source city contributes nothing and is skipped — its
    /// operators get no value from it (mirrors aggregator.rs:42-45).
    #[test]
    fn compute_per_city_skips_zero_weight_city() {
        let mut input = canonical_input();
        // AMS has all the stake; FRA is zero-weight and must be skipped.
        input.city_weights = [("FRA".to_string(), 0.0), ("AMS".to_string(), 1.0)]
            .into_iter()
            .collect();
        input.demands = vec![
            DemandIn {
                start: "FRA".into(),
                end: "AMS".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 0.0,
                kind: 1,
                multicast: false,
            },
            DemandIn {
                start: "AMS".into(),
                end: "FRA".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 0.0,
                kind: 1,
                multicast: false,
            },
        ];
        let result = compute_per_city(&input, &BTreeMap::new(), None).unwrap();
        // Only AMS is solved; FRA is pre-filtered.
        assert_eq!(result.cities_solved, 1);
        assert!(result.per_city.contains_key("AMS"));
        assert!(!result.per_city.contains_key("FRA"));
    }

    // ── reusable_city_values (city-granularity warm-start, D4) ──────────────

    #[test]
    fn reuse_identical_input_reuses_all_cities() {
        let a = canonical_input();
        let b = canonical_input();
        let mut per_city = BTreeMap::new();
        per_city.insert("FRA".to_string(), vec![("Alpha".to_string(), 1.0)]);
        let reuse = reusable_city_values(&a, &b, &per_city);
        // FRA's demand set is unchanged and present in the baseline cache.
        assert_eq!(reuse.get("FRA"), Some(&vec![("Alpha".to_string(), 1.0)]));
    }

    #[test]
    fn reuse_link_change_reuses_nothing() {
        let a = canonical_input();
        let mut b = canonical_input();
        b.private_links[0].latency = 3.0; // shared-topology edit → invalidates all
        let mut per_city = BTreeMap::new();
        per_city.insert("FRA".to_string(), vec![("Alpha".to_string(), 1.0)]);
        let reuse = reusable_city_values(&a, &b, &per_city);
        assert!(
            reuse.is_empty(),
            "a topology edit must invalidate every city"
        );
    }

    #[test]
    fn reuse_demand_override_reuses_untouched_cities() {
        // Same shared topology; FRA's demands unchanged, AMS's demand changed.
        let mut a = canonical_input();
        a.demands = vec![
            DemandIn {
                start: "FRA".into(),
                end: "AMS".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 0.0,
                kind: 1,
                multicast: false,
            },
            DemandIn {
                start: "AMS".into(),
                end: "FRA".into(),
                receivers: 1,
                traffic: 1.0,
                priority: 0.0,
                kind: 1,
                multicast: false,
            },
        ];
        let mut b = a.clone();
        b.demands[1].receivers = 5; // change only AMS's demand
        let mut per_city = BTreeMap::new();
        per_city.insert("FRA".to_string(), vec![("Alpha".to_string(), 1.0)]);
        per_city.insert("AMS".to_string(), vec![("Beta".to_string(), 1.0)]);
        let reuse = reusable_city_values(&a, &b, &per_city);
        assert!(reuse.contains_key("FRA"), "FRA's demands are unchanged");
        assert!(!reuse.contains_key("AMS"), "AMS's demand changed");
    }
}
