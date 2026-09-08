//! `GET /shapley/baseline` and `POST /precompute/baseline` over a mock S3.
//!
//! The probe must never compute or enqueue: every case here runs with no
//! Redis and asserts on status codes and bodies alone.
mod support;

use std::sync::Arc;
use std::time::Duration;

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
    routing::{get, post},
};
use dz_shapley_service::{
    AppState,
    cache::{self, S3Cache},
    diff_store::{DiffStore, NoPersistence},
    model::ShapleyInputIn,
    routes,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use support::MockS3;
use tokio::sync::RwLock;
use tower::ServiceExt;

const TAG: &str = "baseline:epoch-211:canonical-v1:9f2c";

fn state(s3: Option<S3Cache>) -> Arc<AppState> {
    Arc::new(AppState {
        epoch_cache: RwLock::new(None),
        s3_cache: s3,
        api_token: None,
        ingest_token: None,
        jobs: None,
        diff_store: Arc::new(DiffStore::new(Arc::new(NoPersistence))),
        baseline_inflight: Arc::default(),
    })
}

fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/shapley/baseline", get(routes::baseline_probe))
        .route("/precompute/baseline", post(routes::precompute_baseline))
        .with_state(state)
}

fn input() -> ShapleyInputIn {
    serde_json::from_str(include_str!("fixtures/simple.json")).expect("fixture parses")
}

fn alias_body(tag: &str, input_hash: &str) -> Value {
    json!({
        "tag": tag,
        "input_hash": input_hash,
        "method": "lp-per-city-stake-weighted-exact",
        "operator_count": 1,
        "values": { "Alpha": { "value": 1.0, "share": 1.0 } }
    })
}

async fn call(
    router: Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(value) => {
            request = request.header("content-type", "application/json");
            Body::from(serde_json::to_vec(&value).expect("body serializes"))
        }
        None => Body::empty(),
    };
    let response = router
        .oneshot(request.body(body).expect("request builds"))
        .await
        .expect("router answers");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body collects")
        .to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, value)
}

fn probe_uri(tag: &str) -> String {
    format!("/shapley/baseline?tag={}", urlencoding_encode(tag))
}

/// Percent-encode the characters a tag carries (`:` stays legal in a query).
fn urlencoding_encode(tag: &str) -> String {
    tag.replace('%', "%25")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('\0', "%00")
}

#[tokio::test]
async fn probe_hit_returns_the_alias_body() {
    let s3 = MockS3::start().await;
    s3.put(
        &support::baseline_alias_key(TAG),
        alias_body(TAG, "00000000000000aa").to_string().into_bytes(),
        None,
    );
    let (status, body) = call(
        app(state(Some(S3Cache::from(s3.cache_ref())))),
        Method::GET,
        &probe_uri(TAG),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tag"], TAG);
    assert_eq!(body["input_hash"], "00000000000000aa");
    assert_eq!(body["method"], "lp-per-city-stake-weighted-exact");
    assert_eq!(body["values"]["Alpha"]["share"], 1.0);
}

#[tokio::test]
async fn probe_miss_is_not_cached() {
    let s3 = MockS3::start().await;
    let (status, body) = call(
        app(state(Some(S3Cache::from(s3.cache_ref())))),
        Method::GET,
        &probe_uri(TAG),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "status": "not-cached", "tag": TAG }));
}

#[tokio::test]
async fn probe_without_s3_is_not_cached() {
    let (status, body) = call(app(state(None)), Method::GET, &probe_uri(TAG), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["status"], "not-cached");
}

#[tokio::test]
async fn probe_rejects_empty_nul_and_oversized_tags() {
    let s3 = MockS3::start().await;
    let router = app(state(Some(S3Cache::from(s3.cache_ref()))));
    for tag in ["", "a\0b", &"x".repeat(257)] {
        let (status, body) = call(router.clone(), Method::GET, &probe_uri(tag), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "tag {tag:?}");
        assert!(body["error"].is_string(), "tag {tag:?}");
    }
    assert!(
        s3.state.storage.lock().unwrap().requests.is_empty(),
        "rejected tags never reach S3"
    );
}

#[tokio::test]
async fn probe_reports_a_store_failure_as_502() {
    let s3 = MockS3::start().await;
    s3.state.storage.lock().unwrap().get_failure = Some(500);
    let (status, body) = call(
        app(state(Some(S3Cache::from(s3.cache_ref())))),
        Method::GET,
        &probe_uri(TAG),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"], "alias store unavailable");
}

#[tokio::test]
async fn probe_reports_a_foreign_alias_as_502() {
    let s3 = MockS3::start().await;
    s3.put(
        &support::baseline_alias_key(TAG),
        alias_body("some-other-tag", "00000000000000aa")
            .to_string()
            .into_bytes(),
        None,
    );
    let (status, body) = call(
        app(state(Some(S3Cache::from(s3.cache_ref())))),
        Method::GET,
        &probe_uri(TAG),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"], "alias store unavailable");
}

/// Real wall-clock delay: the crate does not enable tokio's paused clock.
#[tokio::test]
async fn probe_times_out_a_stalled_store() {
    let s3 = MockS3::start().await;
    s3.state.storage.lock().unwrap().get_delay =
        routes::BASELINE_PROBE_TIMEOUT + Duration::from_secs(2);
    let started = std::time::Instant::now();
    let (status, body) = call(
        app(state(Some(S3Cache::from(s3.cache_ref())))),
        Method::GET,
        &probe_uri(TAG),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"], "alias store unavailable");
    let elapsed = started.elapsed();
    assert!(
        elapsed >= routes::BASELINE_PROBE_TIMEOUT
            && elapsed < routes::BASELINE_PROBE_TIMEOUT + Duration::from_secs(1),
        "probe returned after {elapsed:?}, expected the {:?} bound",
        routes::BASELINE_PROBE_TIMEOUT
    );
}

#[tokio::test]
async fn publish_short_circuits_on_a_matching_alias() {
    let s3 = MockS3::start().await;
    let input = input();
    let hash_hex = format!("{:016x}", cache::hash_input(&input));
    s3.put(
        &support::baseline_alias_key(TAG),
        alias_body(TAG, &hash_hex).to_string().into_bytes(),
        None,
    );
    let (status, body) = call(
        app(state(Some(S3Cache::from(s3.cache_ref())))),
        Method::POST,
        "/precompute/baseline",
        Some(json!({ "input": input, "tag": TAG })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "already-cached");
    assert_eq!(body["input_hash"], hash_hex);
    assert_eq!(body["tag"], TAG);
}

#[tokio::test]
async fn publish_proceeds_past_a_stale_alias() {
    let s3 = MockS3::start().await;
    s3.put(
        &support::baseline_alias_key(TAG),
        alias_body(TAG, "ffffffffffffffff").to_string().into_bytes(),
        None,
    );
    // No Redis: reaching the queue is what proves the stale alias was not a hit.
    let (status, body) = call(
        app(state(Some(S3Cache::from(s3.cache_ref())))),
        Method::POST,
        "/precompute/baseline",
        Some(json!({ "input": input(), "tag": TAG })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"].as_str().unwrap().contains("REDIS_URL"));
}

#[tokio::test]
async fn publish_requires_s3_and_a_valid_tag() {
    let (status, body) = call(
        app(state(None)),
        Method::POST,
        "/precompute/baseline",
        Some(json!({ "input": input(), "tag": TAG })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"].as_str().unwrap().contains("S3"));

    let s3 = MockS3::start().await;
    let (status, _) = call(
        app(state(Some(S3Cache::from(s3.cache_ref())))),
        Method::POST,
        "/precompute/baseline",
        Some(json!({ "input": input(), "tag": "bad\u{0}tag" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = call(
        app(state(Some(S3Cache::from(s3.cache_ref())))),
        Method::POST,
        "/precompute/baseline",
        Some(json!({ "input": input() })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a missing tag is rejected by the body extractor"
    );
}
