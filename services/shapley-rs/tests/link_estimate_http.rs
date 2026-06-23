//! HTTP-layer test for the faithful `/link-estimate` endpoint (retag-Shapley port
//! of Python `network_linkestimate`). Verifies the wire contract the frontend
//! depends on: `{ method, operator_focus, links: [{device1, device2, value, ...}] }`.
//!
//! Run:  cargo test -p dz-shapley-service --test link_estimate_http

use axum::{
    Router,
    body::Body,
    http::Request,
    routing::{get, post},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower::ServiceExt;

fn app() -> Router {
    // No S3 / Redis in tests: the S3 read-through and job paths are no-ops, so
    // these tests exercise the validation + compute + sweep-summary logic.
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
        .route(
            "/precompute/link-estimates",
            post(dz_shapley_service::routes::link_estimate_sweep),
        )
        .route(
            "/precompute/link-estimates/status",
            get(dz_shapley_service::routes::link_estimate_sweep_status),
        )
        .with_state(state)
}

async fn post_link_estimate(body: Value) -> (axum::http::StatusCode, Value) {
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
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

#[tokio::test]
async fn link_estimate_returns_faithful_per_link_values() {
    let input: Value = serde_json::from_str(include_str!("fixtures/simple.json")).unwrap();
    let body = json!({ "input": input, "operator_focus": "Alpha" });

    let (status, resp) = post_link_estimate(body).await;
    assert_eq!(status, 200, "expected 200, got {status}: {resp}");

    assert_eq!(resp["method"], "retag-shapley-rs");
    assert_eq!(resp["operator_focus"], "Alpha");

    let links = resp["links"].as_array().expect("links array");
    assert!(!links.is_empty(), "Alpha owns links; expected >= 1 row");

    let mut percent_sum = 0.0;
    for l in links {
        // Wire contract the frontend reads.
        let d1 = l["device1"].as_str().unwrap();
        let d2 = l["device2"].as_str().unwrap();
        assert!(d1 < d2, "links are canonical device1 < device2: {d1} {d2}");
        assert!(l["value"].is_number(), "value present");
        let pct = l["percent"].as_f64().unwrap();
        assert!(
            (0.0..=1.0).contains(&pct),
            "percent is a 0–1 fraction: {pct}"
        );
        // Dropped field must be gone.
        assert!(l.get("index").is_none(), "index field should be removed");
        percent_sum += pct;
    }
    // Percent is normalised over positive values → sums to ~1 (unless all ≤ 0).
    assert!(
        (percent_sum - 1.0).abs() < 1e-6 || percent_sum == 0.0,
        "percents should sum to ~1.0, got {percent_sum}"
    );
}

#[tokio::test]
async fn link_estimate_unknown_focus_returns_empty() {
    let input: Value = serde_json::from_str(include_str!("fixtures/simple.json")).unwrap();
    let body = json!({ "input": input, "operator_focus": "Nonexistent" });

    let (status, resp) = post_link_estimate(body).await;
    assert_eq!(status, 200, "unknown focus is not an error: {resp}");
    assert_eq!(resp["links"].as_array().unwrap().len(), 0);
}

/// Dimension limits reject oversized inputs with 400 before any compute.
#[tokio::test]
async fn link_estimate_oversized_input_is_400() {
    let devices: Vec<Value> = (0..501)
        .map(|i| json!({ "device": format!("AAA{}", i + 1), "edge": 1, "operator": "Alpha" }))
        .collect();
    let body = json!({
        "input": {
            "devices": devices,
            "private_links": [
                { "device1": "AAA1", "device2": "AAA2", "latency": 1.0, "bandwidth": 10.0,
                  "uptime": 1.0, "shared": null }
            ],
            "public_links": [],
            "demands": [],
        },
        "operator_focus": "Alpha",
    });

    let (status, resp) = post_link_estimate(body).await;
    assert_eq!(status, 400, "expected 400, got {status}: {resp}");
    assert!(
        resp["error"].as_str().unwrap_or("").contains("devices"),
        "error should name the violated limit: {resp}"
    );
}

/// The sync path hard-caps focus links (a 2^players solve cannot finish within
/// the request timeout) and directs callers to the async job endpoint. No LP
/// runs — the 422 must come back immediately.
#[tokio::test]
async fn link_estimate_sync_cap_directs_to_jobs() {
    // 13 focus-owned links > SYNC_MAX_FOCUS_LINKS (12). The cap check fires
    // before any engine call, so demands/public links can stay empty.
    let mut devices: Vec<Value> = (0..14)
        .map(|i| json!({ "device": format!("AAA{}", i + 1), "edge": 1, "operator": "Alpha" }))
        .collect();
    devices.push(json!({ "device": "BBB1", "edge": 1, "operator": "Beta" }));
    let links: Vec<Value> = (0..13)
        .map(|i| {
            json!({ "device1": format!("AAA{}", i + 1), "device2": format!("AAA{}", i + 2),
                    "latency": 1.0 + i as f64, "bandwidth": 10.0, "uptime": 1.0, "shared": null })
        })
        .collect();
    let body = json!({
        "input": { "devices": devices, "private_links": links, "public_links": [], "demands": [] },
        "operator_focus": "Alpha",
    });

    let (status, resp) = post_link_estimate(body).await;
    assert_eq!(status, 422, "expected 422, got {status}: {resp}");
    let msg = resp["error"].as_str().unwrap_or("");
    assert!(
        msg.contains("jobs/link-estimate"),
        "error should direct callers to the async endpoint: {resp}"
    );
    assert!(
        msg.contains("13"),
        "error should state the offending link count: {resp}"
    );
}

async fn post_sweep(body: Value) -> (axum::http::StatusCode, Value) {
    let resp = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/precompute/link-estimates")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

/// Sweep rejects oversized inputs with 400 before anything else.
#[tokio::test]
async fn sweep_oversized_input_is_400() {
    let devices: Vec<Value> = (0..501)
        .map(|i| json!({ "device": format!("AAA{}", i + 1), "edge": 1, "operator": "Alpha" }))
        .collect();
    let (status, resp) = post_sweep(json!({
        "input": {
            "devices": devices,
            "private_links": [
                { "device1": "AAA1", "device2": "AAA2", "latency": 1.0, "bandwidth": 10.0,
                  "uptime": 1.0, "shared": null }
            ],
            "public_links": [],
            "demands": [],
        },
    }))
    .await;
    assert_eq!(status, 400, "expected 400, got {status}: {resp}");
}

/// The sweep is job-based: it ALWAYS requires the queue (it enqueues a single
/// sweep job and returns 202; the per-operator expansion — including the
/// all-skipped case — happens on a worker). Without Redis it fails loudly,
/// even when every operator would be skipped.
#[tokio::test]
async fn sweep_without_redis_is_503() {
    // Alpha: 20 links (> 19 cap). Beta: a device but no links — under the old
    // synchronous expansion this was a queue-less 200 no-op; the job-based
    // sweep still 503s because the expansion itself runs on a worker.
    let mut devices: Vec<Value> = (0..21)
        .map(|i| json!({ "device": format!("AAA{}", i + 1), "edge": 1, "operator": "Alpha" }))
        .collect();
    devices.push(json!({ "device": "BBB1", "edge": 1, "operator": "Beta" }));
    let links: Vec<Value> = (0..20)
        .map(|i| {
            json!({ "device1": format!("AAA{}", i + 1), "device2": format!("AAA{}", i + 2),
                    "latency": 1.0 + i as f64, "bandwidth": 10.0, "uptime": 1.0, "shared": null })
        })
        .collect();

    let (status, resp) = post_sweep(json!({
        "input": { "devices": devices, "private_links": links, "public_links": [], "demands": [] },
    }))
    .await;
    assert_eq!(status, 503, "sweep requires the job queue: {resp}");
    assert!(
        resp["error"].as_str().unwrap().contains("job queue"),
        "{resp}"
    );

    // Same for a sweep with an explicit operator list.
    let input: Value = serde_json::from_str(include_str!("fixtures/simple.json")).unwrap();
    let (status, resp) = post_sweep(json!({ "input": input, "operators": ["Alpha"] })).await;
    assert_eq!(status, 503, "expected 503, got {status}: {resp}");
}

/// The sweep-status marker endpoint answers without S3 (no markers can exist ⇒
/// `complete: false`), echoing the tag so callers can correlate.
#[tokio::test]
async fn sweep_status_without_s3_is_incomplete() {
    let resp = app()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/precompute/link-estimates/status?tag=epoch-149:canonical-v1:abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["complete"], false);
    assert_eq!(json["tag"], "epoch-149:canonical-v1:abc");
}
