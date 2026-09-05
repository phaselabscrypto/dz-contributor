mod support;
use axum::{Json, extract::State, response::IntoResponse};
use deadpool_redis::{Config, Runtime, redis::AsyncCommands};
use dz_shapley_service::{
    AppState,
    cache::S3Cache,
    diff_store::{DiffStore, NoPersistence},
    jobs::RedisJobStore,
    model::{LinkEstimateRequest, LinkEstimateResponse, ShapleyInputIn, SweepPayload},
    queue::{self, JobKind},
    routes::{self, LinkEstimateSweepRequest},
    worker,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use support::MockS3;

struct Worker(tokio::task::JoinHandle<anyhow::Result<()>>);
impl Drop for Worker {
    fn drop(&mut self) {
        self.0.abort();
    }
}
fn hash(input: &ShapleyInputIn, focus: &str) -> u64 {
    queue::hash_payload(
        &serde_json::to_string(&LinkEstimateRequest {
            input: input.clone(),
            operator_focus: focus.into(),
        })
        .unwrap(),
    )
}
fn result(focus: &str) -> LinkEstimateResponse {
    LinkEstimateResponse {
        method: "cached-test".into(),
        operator_focus: focus.into(),
        links: vec![],
    }
}
fn alias(tag: &str, focus: &str) -> String {
    format!(
        "shapley/v3/canonical/v1/link-estimate-alias-{:016x}.json",
        queue::hash_payload(&format!("{tag}\0{focus}"))
    )
}
fn marker(tag: &str) -> String {
    format!(
        "shapley/v3/canonical/v1/sweep-marker-{:016x}.json",
        queue::hash_payload(tag)
    )
}
async fn done(store: &RedisJobStore, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(snapshot) = store.snapshot(id).await.unwrap() {
                let value = serde_json::to_value(snapshot).unwrap();
                if value["state"] == "done" {
                    return value["result"].clone();
                }
                assert_ne!(value["state"], "failed", "{value}");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("job completes")
}
async fn sweep(state: &Arc<AppState>, input: &ShapleyInputIn, tag: &str) -> String {
    let response = routes::link_estimate_sweep(
        State(state.clone()),
        Json(LinkEstimateSweepRequest {
            input: input.clone(),
            operators: None,
            tag: Some(tag.into()),
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), 202);
    let value: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    value["job_id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn publication_reconciles_cached_results_and_keeps_claims_alive() {
    let url = std::env::var("TEST_REDIS_URL")
        .expect("TEST_REDIS_URL must name an empty isolated test Redis database");
    assert!(
        url.starts_with("redis://127.0.0.1:") || url.starts_with("redis://localhost:"),
        "tests require local isolated Redis"
    );
    let pool = Config::from_url(url)
        .create_pool(Some(Runtime::Tokio1))
        .unwrap();
    let store = RedisJobStore::new(pool);
    let mut conn = store.pool().get().await.unwrap();
    let size: usize = deadpool_redis::redis::cmd("DBSIZE")
        .query_async(&mut conn)
        .await
        .unwrap();
    assert_eq!(size, 0, "test database must be empty");
    store.ensure_group().await.unwrap();
    let s3 = MockS3::start().await;
    let state = Arc::new(AppState {
        epoch_cache: tokio::sync::RwLock::new(None),
        s3_cache: Some(S3Cache::from(s3.cache_ref())),
        api_token: Some("compute".into()),
        ingest_token: Some("ingest".into()),
        jobs: Some(store.clone()),
        diff_store: Arc::new(DiffStore::new(Arc::new(NoPersistence))),
    });
    let input: ShapleyInputIn = serde_json::from_str(include_str!("fixtures/simple.json")).unwrap();
    for op in ["Alpha", "Beta"] {
        s3.put(
            &format!("shapley/v3/link-estimate-{:016x}.bin", hash(&input, op)),
            bincode::serialize(&result(op)).unwrap(),
            Some("\"result\""),
        );
    }
    let mut worker = Worker(tokio::spawn(worker::run(state.clone())));
    s3.put(
        &alias("untrusted", "Alpha").replace("canonical/v1/", ""),
        json!({"payloadHash": format!("{:016x}", hash(&input, "Alpha"))})
            .to_string()
            .into_bytes(),
        None,
    );
    s3.put(
        &marker("untrusted").replace("canonical/v1/", ""),
        b"{}".to_vec(),
        None,
    );
    let cache = state.s3_cache.as_ref().unwrap();
    assert!(
        cache
            .load_link_estimate_alias("untrusted", "Alpha")
            .await
            .is_none()
    );
    assert!(!cache.load_sweep_marker("untrusted").await);
    s3.state.storage.lock().unwrap().put_failure = Some(("link-estimate-alias".into(), 403));
    let id = sweep(&state, &input, "failure").await;
    let summary = done(&store, &id).await;
    assert_eq!(summary["marker_written"], false);
    assert_eq!(summary["failed"].as_array().unwrap().len(), 2);
    assert!(!s3.has(&marker("failure")));
    s3.state.storage.lock().unwrap().put_failure = None;
    let id = sweep(&state, &input, "failure").await;
    let summary = done(&store, &id).await;
    assert_eq!(summary["marker_written"], true);
    assert_eq!(summary["enqueued"], json!([]));
    let requests = s3.state.storage.lock().unwrap().requests.clone();
    let marker_index = requests
        .iter()
        .position(|(method, key)| {
            *method == axum::http::Method::PUT && key.ends_with(&marker("failure"))
        })
        .unwrap();
    for op in ["Alpha", "Beta"] {
        let alias_index = requests
            .iter()
            .rposition(|(method, key)| {
                *method == axum::http::Method::PUT && key.ends_with(&alias("failure", op))
            })
            .unwrap();
        assert!(alias_index < marker_index);
    }

    // Recover Redis-only results without creating solver jobs.
    s3.state.storage.lock().unwrap().objects.clear();
    for op in ["Alpha", "Beta"] {
        store
            .result_cache_set(
                &format!("{:016x}", hash(&input, op)),
                &serde_json::to_value(result(op)).unwrap(),
            )
            .await
            .unwrap();
    }
    s3.state.storage.lock().unwrap().put_failure = Some(("link-estimate-".into(), 403));
    let id = sweep(&state, &input, "redis").await;
    assert_eq!(done(&store, &id).await["marker_written"], false);
    assert!(!s3.has(&alias("redis", "Alpha")));
    s3.state.storage.lock().unwrap().put_failure = None;
    let id = sweep(&state, &input, "redis").await;
    let summary = done(&store, &id).await;
    assert_eq!(summary["marker_written"], true);
    assert_eq!(summary["enqueued"], json!([]));

    // Shared-payload authority also applies to the child's Redis fast path.
    let payload = SweepPayload {
        input: input.clone(),
        operators: vec!["Alpha".into(), "Beta".into()],
        derived_operators: true,
        is_canonical_publish_authorized: true,
        tag: Some("child".into()),
    };
    let parent = store.create().await.unwrap();
    let payload_key = queue::payload_key(&parent);
    store
        .store_payload(&payload_key, &payload, queue::SWEEP_PAYLOAD_TTL_SECS)
        .await
        .unwrap();
    let child = store.create().await.unwrap();
    store
        .enqueue_child(
            &child,
            JobKind::LinkEstimate,
            &payload_key,
            "Alpha",
            &format!("{:016x}", hash(&input, "Alpha")),
        )
        .await
        .unwrap();
    assert_eq!(done(&store, &child).await["method"], "cached-test");
    assert!(s3.has(&alias("child", "Alpha")));
    let mut legacy = serde_json::to_value(&payload).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("is_canonical_publish_authorized");
    legacy["tag"] = json!("legacy");
    let legacy_payload: SweepPayload = serde_json::from_value(legacy).unwrap();
    assert!(!legacy_payload.is_canonical_publish_authorized);
    let id = store.create().await.unwrap();
    store
        .enqueue(&id, JobKind::Sweep, &legacy_payload)
        .await
        .unwrap();
    assert_eq!(done(&store, &id).await["marker_written"], false);
    assert!(!s3.has(&alias("legacy", "Alpha")));

    let mut s3_payload = payload.clone();
    s3_payload.tag = Some("s3-child".into());
    store
        .store_payload(&payload_key, &s3_payload, queue::SWEEP_PAYLOAD_TTL_SECS)
        .await
        .unwrap();
    let _: usize = conn
        .del(queue::result_key(&format!(
            "{:016x}",
            hash(&input, "Alpha")
        )))
        .await
        .unwrap();
    let s3_child = store.create().await.unwrap();
    store
        .enqueue_child(
            &s3_child,
            JobKind::LinkEstimate,
            &payload_key,
            "Alpha",
            &format!("{:016x}", hash(&input, "Alpha")),
        )
        .await
        .unwrap();
    assert_eq!(done(&store, &s3_child).await["method"], "cached-test");
    assert!(s3.has(&alias("s3-child", "Alpha")));

    let mut partial = payload.clone();
    partial.derived_operators = false;
    partial.tag = Some("partial".into());
    let id = store.create().await.unwrap();
    store.enqueue(&id, JobKind::Sweep, &partial).await.unwrap();
    assert_eq!(done(&store, &id).await["marker_written"], false);
    assert!(!s3.has(&alias("partial", "Alpha")));

    let mut cancelled = payload.clone();
    cancelled.tag = Some("cancelled".into());
    store
        .store_payload(&payload_key, &cancelled, queue::SWEEP_PAYLOAD_TTL_SECS)
        .await
        .unwrap();
    let id = store.create().await.unwrap();
    store.request_cancel(&id).await.unwrap();
    store
        .enqueue_child(
            &id,
            JobKind::LinkEstimate,
            &payload_key,
            "Alpha",
            &format!("{:016x}", hash(&input, "Alpha")),
        )
        .await
        .unwrap();
    done(&store, &id).await;
    assert!(!s3.has(&alias("cancelled", "Alpha")));

    let mut fresh_input = input.clone();
    fresh_input.demand_multiplier = 1.001;
    let fresh = sweep(&state, &fresh_input, "computed").await;
    let summary = done(&store, &fresh).await;
    assert_eq!(summary["enqueued"].as_array().unwrap().len(), 2);
    for child in summary["enqueued"].as_array().unwrap() {
        let solved = done(&store, child["job_id"].as_str().unwrap()).await;
        assert_ne!(solved["method"], "cached-test");
        assert!(!solved["links"].as_array().unwrap().is_empty());
        assert!(s3.has(&alias("computed", child["operator"].as_str().unwrap())));
    }
    let fresh = sweep(&state, &fresh_input, "computed").await;
    assert_eq!(done(&store, &fresh).await["marker_written"], true);

    let invalid = routes::link_estimate_sweep(
        State(state.clone()),
        Json(LinkEstimateSweepRequest {
            input: input.clone(),
            operators: None,
            tag: Some("bad\0tag".into()),
        }),
    )
    .await
    .into_response();
    assert_eq!(invalid.status(), 400);

    // Stop after the result PUT and restart before alias repair.
    s3.state.storage.lock().unwrap().put_delay =
        Some(("link-estimate-alias".into(), Duration::from_secs(60)));
    let _interrupted = sweep(&state, &input, "restart").await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if s3
                .state
                .storage
                .lock()
                .unwrap()
                .requests
                .iter()
                .any(|(method, key)| {
                    *method == axum::http::Method::PUT && key.ends_with(&alias("restart", "Alpha"))
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_secs(11)).await;
    let reply: deadpool_redis::redis::streams::StreamAutoClaimReply = conn
        .xautoclaim_options(
            queue::STREAM_KEY,
            queue::CONSUMER_GROUP,
            "other-worker",
            5_000,
            "0-0",
            deadpool_redis::redis::streams::StreamAutoClaimOptions::default(),
        )
        .await
        .unwrap();
    assert!(
        reply.claimed.is_empty(),
        "healthy worker's pending entry was not renewed"
    );
    worker.0.abort();
    let _ = (&mut worker.0).await;
    s3.state.storage.lock().unwrap().put_delay = None;
    worker = Worker(tokio::spawn(worker::run(state.clone())));
    let retry = sweep(&state, &input, "restart").await;
    assert_eq!(done(&store, &retry).await["marker_written"], true);
    assert!(s3.has(&alias("restart", "Alpha")));
    let ttl: i64 = conn.ttl(queue::state_key(&retry)).await.unwrap();
    assert!(ttl > 86_390, "terminal TTL was shortened: {ttl}");
    drop(worker);
    let keys: Vec<String> = conn.keys("shapley:whatif:*").await.unwrap();
    if !keys.is_empty() {
        let _: usize = conn.del(keys).await.unwrap();
    }
}
