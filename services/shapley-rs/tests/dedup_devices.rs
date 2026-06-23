//! Integration test: canonical per-operator device naming.
//!
//! Verifies the Shapley HTTP endpoint works correctly with the DZ
//! canonical device naming format (`{METRO}{N}`, e.g. `FRA1`, `FRA2`)
//! where each device name is unique per operator.
//!
//! The TS input builder now produces these unique names instead of bare
//! metro codes, so duplicate device names are a caller bug and the
//! upstream crate's validation rightfully rejects them (422).
//!
//! Run:  cargo test -p dz-shapley-service --test dedup_devices

use axum::{Router, body::Body, http::Request, routing::post};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower::ServiceExt;

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

fn canonical_payload(devices: Value, private_links: Value) -> Value {
    json!({
        "devices": devices,
        "private_links": private_links,
        "public_links": [
            { "city1": "FRA", "city2": "AMS", "latency": 7.0 }
        ],
        "demands": [
            {
                "start": "FRA",
                "end": "AMS",
                "receivers": 1,
                "traffic": 1.0,
                "priority": 1.0,
                "type": 1,
                "multicast": false
            }
        ],
        // The reward path runs per-source-city + stake-weighted, so a canonical
        // input must carry city_weights (no monolithic fallback). The
        // sole source city here is FRA, so it takes the full weight.
        "city_weights": { "FRA": 1.0 }
    })
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

/// Two operators at the same metro with unique device names (FRA1, FRA2).
/// Both operators should appear with non-zero Shapley values.
#[tokio::test]
async fn two_operators_same_metro_unique_names() {
    let payload = canonical_payload(
        json!([
            { "device": "FRA1", "edge": 1, "operator": "Alpha" },
            { "device": "FRA2", "edge": 0, "operator": "Beta" },
            { "device": "AMS1", "edge": 1, "operator": "Alpha" },
            { "device": "AMS2", "edge": 0, "operator": "Beta" }
        ]),
        json!([
            { "device1": "FRA1", "device2": "AMS1", "latency": 5.0, "bandwidth": 10.0, "uptime": 0.99 },
            { "device1": "FRA2", "device2": "AMS2", "latency": 6.0, "bandwidth": 10.0, "uptime": 0.99 }
        ]),
    );

    let (status, json) = post_shapley(payload).await;

    assert_eq!(status, 200, "canonical input must succeed: {json}");
    assert_eq!(json["operator_count"], 2);
    assert!(json["values"]["Alpha"]["value"].as_f64().unwrap() > 0.0);
    assert!(json["values"]["Beta"]["value"].as_f64().unwrap() > 0.0);
}

/// Single operator with unique device names — should get 100% share.
#[tokio::test]
async fn single_operator_unique_names() {
    let payload = canonical_payload(
        json!([
            { "device": "FRA1", "edge": 1, "operator": "Solo" },
            { "device": "AMS1", "edge": 1, "operator": "Solo" }
        ]),
        json!([
            { "device1": "FRA1", "device2": "AMS1", "latency": 5.0, "bandwidth": 10.0, "uptime": 0.99 }
        ]),
    );

    let (status, json) = post_shapley(payload).await;

    assert_eq!(status, 200, "single operator must succeed: {json}");
    assert_eq!(json["operator_count"], 1);

    let share = json["values"]["Solo"]["share"].as_f64().unwrap();
    assert!(
        (share - 1.0).abs() < 1e-6,
        "single operator should get ~100% share, got {share}"
    );
}

/// Duplicate device names with different operators should now be rejected
/// by the upstream crate's validation (422), since we no longer dedup.
#[tokio::test]
async fn duplicate_device_names_rejected() {
    let payload = canonical_payload(
        json!([
            { "device": "FRA1", "edge": 1, "operator": "Alpha" },
            { "device": "FRA1", "edge": 0, "operator": "Beta" },
            { "device": "AMS1", "edge": 1, "operator": "Alpha" }
        ]),
        json!([
            { "device1": "FRA1", "device2": "AMS1", "latency": 5.0, "bandwidth": 10.0, "uptime": 0.99 }
        ]),
    );

    let (status, _json) = post_shapley(payload).await;

    // The upstream crate validates unique device names and should reject this
    assert_eq!(
        status, 422,
        "duplicate device names should be rejected (422)"
    );
}
