//! Timing probe (not a correctness test): how long does the faithful
//! retag-Shapley link-estimate take at PRODUCTION scale (the epoch-149 fixture)
//! for operators of different link counts?
//!
//! Players = focus links + "Others", so cost = 2^(links+1) coalition LPs in ONE
//! solve — versus the reward path's `cities × 2^operators` LPs. Run release for
//! meaningful numbers:
//!
//!   cargo test --release --test linkest_timing -- --ignored --nocapture
//!
//! Skips gracefully when the epoch-149 fixture is absent.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use axum::{Router, body::Body, http::Request, routing::post};
use http_body_util::BodyExt;
use serde_json::Value;
use tokio::sync::RwLock;
use tower::ServiceExt;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/epoch149/input.json")
}

fn app() -> Router {
    let state = Arc::new(dz_shapley_service::AppState {
        epoch_cache: RwLock::new(None),
        s3_cache: None,
        api_token: None,
        jobs: None,
    });
    Router::new()
        .route(
            "/link-estimate",
            post(dz_shapley_service::routes::link_estimate),
        )
        .with_state(state)
}

/// links per operator under the engine's OR-ownership rule.
fn links_per_operator(input: &Value) -> HashMap<String, usize> {
    let device_op: HashMap<&str, &str> = input["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            (
                d["device"].as_str().unwrap(),
                d["operator"].as_str().unwrap(),
            )
        })
        .collect();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for l in input["private_links"].as_array().unwrap() {
        let owners: HashSet<&str> = [
            l["device1"].as_str().unwrap(),
            l["device2"].as_str().unwrap(),
        ]
        .iter()
        .filter_map(|d| device_op.get(d).copied())
        .collect();
        for op in owners {
            *counts.entry(op.to_string()).or_default() += 1;
        }
    }
    counts
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "timing probe at production scale; needs the epoch-149 fixture"]
async fn time_link_estimate_at_epoch149_scale() {
    let path = fixture_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        eprintln!("SKIP: no epoch-149 fixture at {}", path.display());
        return;
    };
    let input: Value = serde_json::from_str(&raw).expect("parse input.json");

    // Pick the smallest / a middle / the largest sync-eligible (<=12 links)
    // operator so the scaling is visible.
    let mut counts: Vec<(String, usize)> = links_per_operator(&input).into_iter().collect();
    counts.sort_by_key(|(_, n)| *n);
    eprintln!(
        "operators by link count: {:?}",
        counts
            .iter()
            .map(|(op, n)| format!("{}…={n}", &op[..6.min(op.len())]))
            .collect::<Vec<_>>()
    );
    let eligible: Vec<&(String, usize)> = counts.iter().filter(|(_, n)| *n <= 12).collect();
    let picks: Vec<&(String, usize)> = match eligible.len() {
        0 => vec![],
        1 => vec![eligible[0]],
        n => vec![eligible[0], eligible[n / 2], eligible[n - 1]],
    };

    for (op, links) in picks {
        let body = serde_json::json!({ "input": input, "operator_focus": op });
        let start = std::time::Instant::now();
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/link-estimate")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let elapsed = start.elapsed();
        let rows = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v["links"].as_array().map(|a| a.len()))
            .unwrap_or(0);
        eprintln!(
            "operator {}… links={links} players={} coalitions={} -> {status} {rows} rows in {:.1}s",
            &op[..6.min(op.len())],
            links + 1,
            1u64 << (links + 1),
            elapsed.as_secs_f64(),
        );
        assert!(status.is_success(), "solve failed for {op}");
    }
}
