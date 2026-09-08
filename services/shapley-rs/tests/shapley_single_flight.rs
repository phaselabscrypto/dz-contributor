//! One cold `/shapley` solve per input hash: followers wait for the leader
//! and never start their own solve.
mod support;

use std::sync::Arc;
use std::time::Duration;

use axum::{Router, body::Body, http::Request, routing::post};
use dz_shapley_service::{
    AppState,
    cache::{self, S3Cache},
    diff_store::{DiffStore, NoPersistence},
    inflight::Flight,
    model::{ShapleyInputIn, ShapleyResponse},
    routes,
};
use http_body_util::BodyExt;
use serde_json::Value;
use support::MockS3;
use tokio::sync::RwLock;
use tower::ServiceExt;

fn state(s3: &MockS3) -> Arc<AppState> {
    Arc::new(AppState {
        epoch_cache: RwLock::new(None),
        s3_cache: Some(S3Cache::from(s3.cache_ref())),
        api_token: None,
        ingest_token: None,
        jobs: None,
        diff_store: Arc::new(DiffStore::new(Arc::new(NoPersistence))),
        baseline_inflight: Arc::default(),
    })
}

fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/shapley", post(routes::shapley))
        .with_state(state)
}

async fn post_shapley(router: Router, input: ShapleyInputIn) -> (u16, Value) {
    let request = Request::builder()
        .method("POST")
        .uri("/shapley")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&input).expect("input serializes"),
        ))
        .expect("request builds");
    let response = router.oneshot(request).await.expect("router answers");
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body collects")
        .to_bytes();
    (status, serde_json::from_slice(&bytes).expect("json body"))
}

fn cache_puts(s3: &MockS3) -> usize {
    s3.state
        .storage
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|(method, key)| method == "PUT" && key.contains("/cache-"))
        .count()
}

#[tokio::test]
async fn a_follower_waits_for_the_leader_and_never_solves() {
    let s3 = MockS3::start().await;
    let state = state(&s3);
    let input = support::canonical_two_operator_input();
    let hash = cache::hash_input(&input);

    let Flight::Lead(guard) = state.baseline_inflight.join(hash) else {
        panic!("the test must lead the flight");
    };
    let follower = tokio::spawn(post_shapley(app(state.clone()), input.clone()));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !follower.is_finished(),
        "follower answered before the leader finished"
    );

    let injected = ShapleyResponse {
        method: "injected-by-test".into(),
        operator_count: 1,
        values: [(
            "Alpha".to_string(),
            dz_shapley_service::model::ShapleyOperatorOut {
                value: 42.0,
                share: 1.0,
            },
        )]
        .into_iter()
        .collect(),
    };
    guard.finish(Ok(injected));

    let (status, body) = follower.await.expect("follower task");
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["method"], "injected-by-test");
    assert_eq!(body["values"]["Alpha"]["value"], 42.0);
    assert_eq!(cache_puts(&s3), 0, "the follower must not solve or store");
}

#[tokio::test]
async fn a_dropped_leader_fails_the_follower() {
    let s3 = MockS3::start().await;
    let state = state(&s3);
    let input = support::canonical_two_operator_input();
    let hash = cache::hash_input(&input);

    let Flight::Lead(guard) = state.baseline_inflight.join(hash) else {
        panic!("the test must lead the flight");
    };
    let follower = tokio::spawn(post_shapley(app(state.clone()), input.clone()));
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(guard);

    let (status, body) = follower.await.expect("follower task");
    assert_eq!(status, 500, "{body}");
    assert!(body["error"].is_string());
    assert_eq!(cache_puts(&s3), 0);
}

#[tokio::test]
async fn sequential_requests_solve_once() {
    let s3 = MockS3::start().await;
    let state = state(&s3);
    let input = support::canonical_two_operator_input();

    let (first, body) = post_shapley(app(state.clone()), input.clone()).await;
    assert_eq!(first, 200, "{body}");
    assert_eq!(body["operator_count"], 2);
    let (second, _) = post_shapley(app(state.clone()), input.clone()).await;
    assert_eq!(second, 200);

    // The store is detached from the request; give it a moment to land.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while cache_puts(&s3) == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(cache_puts(&s3), 1, "second request was a memory hit");
    assert!(s3.has(&support::baseline_cache_key(cache::hash_input(&input))));
}
