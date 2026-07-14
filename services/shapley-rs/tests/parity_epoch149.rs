//! DoubleZero parity — epoch 149 reward-leaf golden.
//!
//! THE "never diverge again" guardrail. Feeds the canonical epoch-149 input
//! through the real `/shapley` handler (per-source-city exact Shapley +
//! stake-weighted aggregation), converts the aggregated proportions to on-chain
//! `unit_share`s exactly as DZ's `proof.rs` does, and asserts the result equals
//! DoubleZero's **actual on-chain `RewardShare`s** for epoch 149.
//!
//! Reference: `contributor-rewards/v0.5.3` → `network-shapley-rs v0.5.0`.
//! See `services/shapley-rs/docs/DZ_PARITY.md`.
//!
//! HISTORICAL ANCHOR (pre-#369). Epoch-149's on-chain leaves were computed with
//! the OLD reward params (IBRL priority 0.0, public-latency ×1.0) and the
//! superseded v0.5.0 linear uptime penalty. The canonical TS builder now targets
//! DoubleZero's CURRENT (post-#369) methodology (IBRL priority 20.0, public
//! latency ×1.25) — empirically parity-verified against DZ's own `export shapley`
//! at epoch 184 (max |Δproportion| = 2.35e-15; see
//! `~/.claude/plans/dz-contributor-dz-export-okd-parity_walkthrough.md`). This
//! test therefore validates a *superseded* epoch under its *original* params and
//! is intentionally reproduced with the historical override in
//! `scripts/gen-epoch149-parity-fixture.ts`; it is NOT the current-parity gate.
//!
//! Gated `#[ignore]` (the per-city exact solve at production scale is heavy) and
//! SKIPS (does not fail) when the fixture is absent, so CI stays green until the
//! fixture is generated:
//!
//!   DZ_LEDGER_RPC_URL=... npx tsx scripts/gen-epoch149-parity-fixture.ts
//!   cd services/shapley-rs && cargo test --test parity_epoch149 -- --ignored --nocapture
//!
//! Fixtures (under `tests/fixtures/epoch149/`):
//!   - `input.json` — canonical `ShapleyInputIn`, devices keyed by owner PUBKEY (so output is pubkey-keyed like DZ), incl. `city_weights`.
//!   - `expected_leaves.json` — decoded on-chain leaves: `{ "<owner_pubkey>": <unit_share u32>, ... }`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{Router, body::Body, http::Request, routing::post};
use http_body_util::BodyExt;
use serde_json::Value;
use tokio::sync::RwLock;
use tower::ServiceExt;

/// MAX_UNIT_SHARE — must equal DZ `calculator/constants.rs` (and the on-chain
/// contract): the total `unit_share` across all contributors is exactly this.
const MAX_UNIT_SHARE: u64 = 1_000_000_000;
/// Absolute tolerance on the secondary raw-proportion cross-check (DZ rounds to
/// 4 dp when it publishes, so we never assert tighter than that on raw values).
const RAW_ABS_TOL: f64 = 2e-4;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/epoch149")
}

fn app() -> Router {
    let state = Arc::new(dz_shapley_service::AppState {
        epoch_cache: RwLock::new(None),
        s3_cache: None,
        api_token: None,
        jobs: None,
    });
    Router::new()
        .route("/shapley", post(dz_shapley_service::routes::shapley))
        .with_state(state)
}

async fn post_shapley(payload: Value) -> (u16, Value) {
    let req = Request::builder()
        .method("POST")
        .uri("/shapley")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap();
    let resp = app().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&body).unwrap();
    (status, json)
}

/// Port of DZ `proof.rs::ShapleyOutputStorage::new` (`v0.5.3:25-74`):
///   • iterate operators in pubkey order (a BTreeMap is already sorted);
///   • `unit_share = floor(clamp(proportion, 0, 1) · MAX_UNIT_SHARE)`;
///   • top up the FIRST operator (smallest pubkey) with the rounding remainder
///     so the total is exactly MAX_UNIT_SHARE.
/// Returns `(pubkey -> unit_share, total)`.
fn to_unit_shares(proportions: &BTreeMap<String, f64>) -> (BTreeMap<String, u32>, u64) {
    let mut leaves: BTreeMap<String, u32> = BTreeMap::new();
    let mut total: u64 = 0;
    for (pk, &p) in proportions {
        let clamped = p.clamp(0.0, 1.0);
        let scaled = (clamped * MAX_UNIT_SHARE as f64).floor() as u64;
        let unit = scaled.min(MAX_UNIT_SHARE) as u32;
        leaves.insert(pk.clone(), unit);
        total += unit as u64;
    }
    // Reconcile to exactly MAX_UNIT_SHARE on the first (smallest-pubkey) reward.
    if let Some((_, first)) = leaves.iter_mut().next() {
        let remainder = (MAX_UNIT_SHARE.saturating_sub(total)) as u32;
        *first += remainder;
        total += remainder as u64;
    }
    (leaves, total)
}

#[tokio::test]
#[ignore = "heavy per-city exact LP + needs the generated epoch-149 fixture"]
async fn epoch149_reward_leaves_match_onchain() {
    let dir = fixture_dir();
    let input_path = dir.join("input.json");
    let leaves_path = dir.join("expected_leaves.json");
    if !input_path.exists() || !leaves_path.exists() {
        eprintln!(
            "SKIP epoch149 parity: fixtures absent ({}). Generate with \
             `DZ_LEDGER_RPC_URL=... npx tsx scripts/gen-epoch149-parity-fixture.ts`.",
            dir.display()
        );
        return;
    }

    let input: Value =
        serde_json::from_str(&std::fs::read_to_string(&input_path).unwrap()).unwrap();
    let expected: BTreeMap<String, u32> =
        serde_json::from_str(&std::fs::read_to_string(&leaves_path).unwrap()).unwrap();

    // Run the real reward path (per-city exact + stake-weighted aggregation).
    let (status, json) = post_shapley(input).await;
    assert_eq!(
        status, 200,
        "/shapley must succeed for epoch-149 input: {json}"
    );

    // Aggregated proportions, keyed by operator (= owner pubkey in the fixture).
    let values = json["values"].as_object().expect("values object");
    let proportions: BTreeMap<String, f64> = values
        .iter()
        .map(|(op, v)| (op.clone(), v["share"].as_f64().expect("share f64")))
        .collect();

    // PRIMARY (authoritative): on-chain reward-leaf parity.
    let (ours, total) = to_unit_shares(&proportions);
    assert_eq!(
        total, MAX_UNIT_SHARE,
        "unit_shares must sum to exactly {MAX_UNIT_SHARE}, got {total}"
    );
    assert_eq!(
        ours.len(),
        expected.len(),
        "operator count mismatch: ours={} chain={}",
        ours.len(),
        expected.len()
    );
    let mut mismatches = Vec::new();
    for (pk, &exp) in &expected {
        match ours.get(pk) {
            Some(&got) if got == exp => {}
            Some(&got) => mismatches.push(format!("{pk}: ours={got} chain={exp}")),
            None => mismatches.push(format!("{pk}: MISSING from ours (chain={exp})")),
        }
    }
    assert!(
        mismatches.is_empty(),
        "reward-leaf parity FAILED vs on-chain epoch 149:\n{}",
        mismatches.join("\n")
    );

    // SECONDARY (optional): raw proportion cross-check against a locally-run DZ
    // `aggregate_shapley_outputs` reference, when present. On-chain alone cannot
    // supply pre-clamp raw values, so this only runs if the fixture is provided.
    let raw_path = dir.join("expected_raw_proportions.json");
    if raw_path.exists() {
        let expected_raw: BTreeMap<String, f64> =
            serde_json::from_str(&std::fs::read_to_string(&raw_path).unwrap()).unwrap();
        for (pk, &exp) in &expected_raw {
            let got = proportions.get(pk).copied().unwrap_or(f64::NAN);
            assert!(
                (got - exp).abs() < RAW_ABS_TOL,
                "raw proportion {pk}: ours={got} dz={exp} (tol {RAW_ABS_TOL})"
            );
        }
    }
}

/// Smoke: run the real per-city reward path on the epoch-149 `input.json` (no
/// on-chain leaves needed). Confirms it executes at production scale (14 ops, 28
/// cities, 1148 demands) without erroring, that proportions sum to ~1.0, and
/// prints a wall-clock timing — the empirical answer to "how slow is per-city
/// exact?". `#[ignore]` (heavy); skips if `input.json` is absent.
#[tokio::test]
#[ignore = "heavy per-city exact LP at production scale"]
async fn epoch149_per_city_runs() {
    let input_path = fixture_dir().join("input.json");
    if !input_path.exists() {
        eprintln!("SKIP: {} absent", input_path.display());
        return;
    }
    let input: Value =
        serde_json::from_str(&std::fs::read_to_string(&input_path).unwrap()).unwrap();

    let t0 = std::time::Instant::now();
    let (status, json) = post_shapley(input).await;
    let elapsed = t0.elapsed();
    eprintln!(
        "epoch149 per-city /shapley: status={status} elapsed={:.1}s method={}",
        elapsed.as_secs_f64(),
        json["method"].as_str().unwrap_or("?"),
    );
    assert_eq!(status, 200, "per-city reward path must succeed: {json}");
    let values = json["values"].as_object().expect("values");
    let total: f64 = values.values().map(|v| v["share"].as_f64().unwrap()).sum();
    eprintln!("operators={} share_sum={total:.6}", values.len());
    assert!(
        (total - 1.0).abs() < 1e-6 || total.abs() < 1e-9,
        "shares should sum to ~1.0 (or ~0 if degenerate), got {total}"
    );
}

/// Cheap, always-on sanity for the leaf conversion math (no fixture / no LP).
/// Pins the `floor(clamp·1e9)` + remainder-to-first behaviour even in CI.
#[test]
fn to_unit_shares_matches_dz_proof_semantics() {
    // Two operators, 1/3 and 2/3 — floors leave a 1-unit remainder that must
    // land on the first (smallest-pubkey) reward so the total is exact.
    let props: BTreeMap<String, f64> = [
        ("AAA".to_string(), 1.0 / 3.0),
        ("BBB".to_string(), 2.0 / 3.0),
    ]
    .into_iter()
    .collect();
    let (leaves, total) = to_unit_shares(&props);
    assert_eq!(total, MAX_UNIT_SHARE);
    // floor(1/3·1e9)=333_333_333, floor(2/3·1e9)=666_666_666, sum=999_999_999,
    // remainder 1 → first ("AAA") becomes 333_333_334.
    assert_eq!(leaves["AAA"], 333_333_334);
    assert_eq!(leaves["BBB"], 666_666_666);

    // Negative + >1 raw shares clamp to [0,1] before flooring (DZ proof.rs).
    let props2: BTreeMap<String, f64> = [
        ("AAA".to_string(), -0.5), // clamps to 0
        ("BBB".to_string(), 1.5),  // clamps to 1 → 1e9
    ]
    .into_iter()
    .collect();
    let (leaves2, total2) = to_unit_shares(&props2);
    assert_eq!(total2, MAX_UNIT_SHARE);
    assert_eq!(leaves2["AAA"], 0);
    assert_eq!(leaves2["BBB"], MAX_UNIT_SHARE as u32);
}
