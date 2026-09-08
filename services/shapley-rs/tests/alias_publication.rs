//! Alias publication end to end: a real worker, a real Redis, and a mock S3.
//!
//! One test runs the scenarios in sequence because they share the worker,
//! the Redis database, and the S3 objects earlier scenarios leave behind.
mod support;
use axum::{Json, extract::State, http::Method, response::IntoResponse};
use deadpool_redis::redis::streams::{StreamAutoClaimOptions, StreamAutoClaimReply};
use deadpool_redis::{Config, Connection, Runtime, redis::AsyncCommands};
use dz_shapley_service::{
    AppState, cache,
    cache::S3Cache,
    diff_store::{DiffStore, NoPersistence},
    jobs::RedisJobStore,
    model::{
        BaselinePublishPayload, BaselineVariant, LinkEstimateRequest, LinkEstimateResponse,
        ShapleyInputIn, SweepPayload,
    },
    queue::{self, JobKind},
    routes::{self, BaselinePublishRequest, LinkEstimateSweepRequest},
    worker,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use support::MockS3;

const OPERATORS: [&str; 2] = ["Alpha", "Beta"];
const PUBLICATION_PREFIX: &str = "publication/v1/";

/// Aborts the worker task when dropped.
struct Worker(tokio::task::JoinHandle<anyhow::Result<()>>);
impl Drop for Worker {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Deletes every key the test wrote, also after a failed assertion, so the
/// next run's empty-database check passes. Runs synchronously: on the
/// current-thread test runtime no task can write while this executes.
struct RedisCleanup(String);
impl Drop for RedisCleanup {
    fn drop(&mut self) {
        let Ok(client) = deadpool_redis::redis::Client::open(self.0.as_str()) else {
            return;
        };
        let Ok(mut conn) = client.get_connection() else {
            return;
        };
        let keys: Vec<String> = deadpool_redis::redis::cmd("KEYS")
            .arg("shapley:*")
            .query(&mut conn)
            .unwrap_or_default();
        if !keys.is_empty() {
            let _: Result<usize, _> = deadpool_redis::redis::cmd("DEL").arg(keys).query(&mut conn);
        }
    }
}

struct Harness {
    store: RedisJobStore,
    conn: Connection,
    s3: MockS3,
    state: Arc<AppState>,
    input: ShapleyInputIn,
    worker: Worker,
    _cleanup: RedisCleanup,
}

impl Harness {
    /// Connects to the isolated test Redis, refuses a remote or occupied
    /// database, starts a worker, and seeds S3 with a persisted result for
    /// every operator.
    async fn start() -> Self {
        let url = std::env::var("TEST_REDIS_URL")
            .expect("TEST_REDIS_URL must name an empty isolated test Redis database");
        assert!(
            url.starts_with("redis://127.0.0.1:") || url.starts_with("redis://localhost:"),
            "tests require local isolated Redis"
        );
        let pool = Config::from_url(url.as_str())
            .create_pool(Some(Runtime::Tokio1))
            .unwrap();
        let store = RedisJobStore::new(pool);
        let mut conn = store.pool().get().await.unwrap();
        let size: usize = deadpool_redis::redis::cmd("DBSIZE")
            .query_async(&mut conn)
            .await
            .unwrap();
        assert_eq!(size, 0, "test database must be empty");
        let cleanup = RedisCleanup(url);
        store.ensure_group().await.unwrap();
        let s3 = MockS3::start().await;
        let state = Arc::new(AppState {
            epoch_cache: tokio::sync::RwLock::new(None),
            s3_cache: Some(S3Cache::from(s3.cache_ref())),
            api_token: Some("compute".into()),
            ingest_token: Some("ingest".into()),
            jobs: Some(store.clone()),
            diff_store: Arc::new(DiffStore::new(Arc::new(NoPersistence))),
            baseline_inflight: Arc::default(),
        });
        let input: ShapleyInputIn =
            serde_json::from_str(include_str!("fixtures/simple.json")).unwrap();
        let worker = Worker(tokio::spawn(worker::run(state.clone())));
        let harness = Self {
            store,
            conn,
            s3,
            state,
            input,
            worker,
            _cleanup: cleanup,
        };
        harness.seed_persisted_results();
        harness
    }

    fn hash(&self, focus: &str) -> u64 {
        queue::hash_payload(
            &serde_json::to_string(&LinkEstimateRequest {
                input: self.input.clone(),
                operator_focus: focus.into(),
            })
            .unwrap(),
        )
    }

    fn hash_hex(&self, focus: &str) -> String {
        format!("{:016x}", self.hash(focus))
    }

    fn result_key(&self, focus: &str) -> String {
        format!("shapley/v3/link-estimate-{}.bin", self.hash_hex(focus))
    }

    fn seed_persisted_results(&self) {
        for op in OPERATORS {
            self.s3.put(
                &self.result_key(op),
                bincode::serialize(&result(op)).unwrap(),
                Some("\"result\""),
            );
        }
    }

    async fn seed_redis_results(&self) {
        for op in OPERATORS {
            self.store
                .result_cache_set(
                    &self.hash_hex(op),
                    &serde_json::to_value(result(op)).unwrap(),
                )
                .await
                .unwrap();
        }
    }

    /// Makes every PUT whose key contains the needle fail with the status, or
    /// clears the fault when `None`.
    fn fail_puts(&self, fault: Option<(&str, u16)>) {
        self.s3.state.storage.lock().unwrap().put_failure =
            fault.map(|(needle, status)| (needle.to_owned(), status));
    }

    /// Delays every PUT whose key contains the needle, or clears the delay.
    fn delay_puts(&self, delay: Option<(&str, Duration)>) {
        self.s3.state.storage.lock().unwrap().put_delay =
            delay.map(|(needle, duration)| (needle.to_owned(), duration));
    }

    fn requests(&self) -> Vec<(Method, String)> {
        self.s3.state.storage.lock().unwrap().requests.clone()
    }

    /// Submits a derived-operator sweep through the route and returns its job id.
    async fn sweep(&self, input: &ShapleyInputIn, tag: &str) -> String {
        let response = routes::link_estimate_sweep(
            State(self.state.clone()),
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

    /// Waits for the job to finish and returns its result; a failed job panics.
    async fn done(&self, id: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Some(snapshot) = self.store.snapshot(id).await.unwrap() {
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

    fn authorized_payload(&self, tag: &str) -> SweepPayload {
        SweepPayload {
            input: self.input.clone(),
            operators: OPERATORS.iter().map(|op| (*op).to_owned()).collect(),
            derived_operators: true,
            is_publish_authorized: true,
            tag: Some(tag.into()),
        }
    }

    /// Stores a shared sweep payload under a fresh parent job and returns its key.
    async fn store_shared_payload(&self, payload: &SweepPayload) -> String {
        let parent = self.store.create().await.unwrap();
        let key = queue::payload_key(&parent);
        self.store
            .store_payload(&key, payload, queue::SWEEP_PAYLOAD_TTL_SECS)
            .await
            .unwrap();
        key
    }

    /// Enqueues one link-estimate child for `op` against a shared payload.
    async fn enqueue_child(&self, payload_key: &str, op: &str) -> String {
        let child = self.store.create().await.unwrap();
        self.store
            .enqueue_child(
                &child,
                JobKind::LinkEstimate,
                payload_key,
                op,
                &self.hash_hex(op),
            )
            .await
            .unwrap();
        child
    }

    async fn restart_worker(&mut self) {
        self.worker.0.abort();
        let _ = (&mut self.worker.0).await;
        self.worker = Worker(tokio::spawn(worker::run(self.state.clone())));
    }
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
        "shapley/v3/{PUBLICATION_PREFIX}link-estimate-alias-{:016x}.json",
        queue::hash_payload(&format!("{tag}\0{focus}"))
    )
}

fn marker(tag: &str) -> String {
    format!(
        "shapley/v3/{PUBLICATION_PREFIX}sweep-marker-{:016x}.json",
        queue::hash_payload(tag)
    )
}

/// The same key under the prefix that predates trusted publication.
fn legacy_key(key: &str) -> String {
    key.replace(PUBLICATION_PREFIX, "")
}

fn is_put_of(request: &(Method, String), key: &str) -> bool {
    request.0 == Method::PUT && request.1.ends_with(key)
}

/// Aliases and markers under the pre-publication prefix are never read.
async fn legacy_metadata_is_not_read(h: &Harness) {
    h.s3.put(
        &legacy_key(&alias("untrusted", "Alpha")),
        json!({ "payloadHash": h.hash_hex("Alpha") })
            .to_string()
            .into_bytes(),
        None,
    );
    h.s3.put(&legacy_key(&marker("untrusted")), b"{}".to_vec(), None);
    let cache = h.state.s3_cache.as_ref().unwrap();
    assert!(
        cache
            .load_link_estimate_alias("untrusted", "Alpha")
            .await
            .is_none()
    );
    assert!(!cache.load_sweep_marker("untrusted").await);
}

/// A failed alias write is recorded per operator and withholds the marker.
/// The retry publishes every alias before the marker.
async fn failed_alias_write_withholds_marker_until_retry(h: &Harness) {
    h.fail_puts(Some(("link-estimate-alias", 403)));
    let summary = h.done(&h.sweep(&h.input, "failure").await).await;
    assert_eq!(summary["marker_written"], false);
    assert_eq!(summary["failed"].as_array().unwrap().len(), 2);
    assert!(!h.s3.has(&marker("failure")));

    h.fail_puts(None);
    let summary = h.done(&h.sweep(&h.input, "failure").await).await;
    assert_eq!(summary["marker_written"], true);
    assert_eq!(summary["enqueued"], json!([]));
    let requests = h.requests();
    let marker_index = requests
        .iter()
        .position(|request| is_put_of(request, &marker("failure")))
        .unwrap();
    for op in OPERATORS {
        let alias_index = requests
            .iter()
            .rposition(|request| is_put_of(request, &alias("failure", op)))
            .unwrap();
        assert!(
            alias_index < marker_index,
            "alias for {op} must land before the marker"
        );
    }
}

/// Results that exist only in the Redis result cache are persisted and
/// aliased without solver jobs. A failed result write withholds the alias.
async fn redis_only_results_are_published_without_solver_jobs(h: &Harness) {
    h.s3.state.storage.lock().unwrap().objects.clear();
    h.seed_redis_results().await;
    h.fail_puts(Some(("link-estimate-", 403)));
    let summary = h.done(&h.sweep(&h.input, "redis").await).await;
    assert_eq!(summary["marker_written"], false);
    assert!(!h.s3.has(&alias("redis", "Alpha")));

    h.fail_puts(None);
    let summary = h.done(&h.sweep(&h.input, "redis").await).await;
    assert_eq!(summary["marker_written"], true);
    assert_eq!(summary["enqueued"], json!([]));
}

/// A sweep child served from the Redis result cache publishes under the
/// authority stored in its parent's shared payload.
async fn child_fast_path_publishes_with_shared_authority(h: &Harness) {
    let payload_key = h.store_shared_payload(&h.authorized_payload("child")).await;
    let child = h.enqueue_child(&payload_key, "Alpha").await;
    assert_eq!(h.done(&child).await["method"], "cached-test");
    assert!(h.s3.has(&alias("child", "Alpha")));
}

/// A payload stored before `is_publish_authorized` existed decodes as
/// unauthorized and publishes nothing.
async fn legacy_payload_cannot_publish(h: &Harness) {
    let mut legacy = serde_json::to_value(h.authorized_payload("legacy")).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("is_publish_authorized");
    let payload: SweepPayload = serde_json::from_value(legacy).unwrap();
    assert!(!payload.is_publish_authorized);
    let id = h.store.create().await.unwrap();
    h.store
        .enqueue(&id, JobKind::Sweep, &payload)
        .await
        .unwrap();
    assert_eq!(h.done(&id).await["marker_written"], false);
    assert!(!h.s3.has(&alias("legacy", "Alpha")));
}

/// A child served from S3 publishes too, so an epoch solved before aliases
/// existed is back-filled by the next sweep.
async fn child_served_from_s3_publishes(h: &mut Harness) {
    let payload_key = h
        .store_shared_payload(&h.authorized_payload("s3-child"))
        .await;
    let redis_result = queue::result_key(&h.hash_hex("Alpha"));
    let _: usize = h.conn.del(redis_result).await.unwrap();
    let child = h.enqueue_child(&payload_key, "Alpha").await;
    assert_eq!(h.done(&child).await["method"], "cached-test");
    assert!(h.s3.has(&alias("s3-child", "Alpha")));
}

/// An explicit operator list may be partial, so it never publishes.
async fn explicit_operator_list_cannot_publish(h: &Harness) {
    let mut partial = h.authorized_payload("partial");
    partial.derived_operators = false;
    let id = h.store.create().await.unwrap();
    h.store
        .enqueue(&id, JobKind::Sweep, &partial)
        .await
        .unwrap();
    assert_eq!(h.done(&id).await["marker_written"], false);
    assert!(!h.s3.has(&alias("partial", "Alpha")));
}

/// A child cancelled before pickup completes from the cache but publishes
/// nothing.
async fn cancelled_child_does_not_publish(h: &Harness) {
    let payload_key = h
        .store_shared_payload(&h.authorized_payload("cancelled"))
        .await;
    let id = h.store.create().await.unwrap();
    h.store.request_cancel(&id).await.unwrap();
    h.store
        .enqueue_child(
            &id,
            JobKind::LinkEstimate,
            &payload_key,
            "Alpha",
            &h.hash_hex("Alpha"),
        )
        .await
        .unwrap();
    h.done(&id).await;
    assert!(!h.s3.has(&alias("cancelled", "Alpha")));
}

/// A fresh input is solved, persisted, and aliased; the next sweep finds
/// everything cached and writes the marker.
async fn fresh_solves_publish_then_mark(h: &Harness) {
    let mut fresh_input = h.input.clone();
    fresh_input.demand_multiplier = 1.001;
    let summary = h.done(&h.sweep(&fresh_input, "computed").await).await;
    let enqueued = summary["enqueued"].as_array().unwrap();
    assert_eq!(enqueued.len(), 2);
    for child in enqueued {
        let solved = h.done(child["job_id"].as_str().unwrap()).await;
        assert_ne!(solved["method"], "cached-test");
        assert!(!solved["links"].as_array().unwrap().is_empty());
        assert!(h.s3.has(&alias("computed", child["operator"].as_str().unwrap())));
    }
    let summary = h.done(&h.sweep(&fresh_input, "computed").await).await;
    assert_eq!(summary["marker_written"], true);
}

/// The route rejects a tag carrying the alias key's separator byte.
async fn nul_in_tag_is_rejected(h: &Harness) {
    let response = routes::link_estimate_sweep(
        State(h.state.clone()),
        Json(LinkEstimateSweepRequest {
            input: h.input.clone(),
            operators: None,
            tag: Some("bad\0tag".into()),
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), 400);
}

/// A worker stalled in an alias write keeps renewing its claim, so no other
/// worker reclaims the entry. After a restart the next sweep completes the
/// publication, and the terminal retention is intact.
async fn stalled_publication_keeps_claim_and_recovers_after_restart(h: &mut Harness) {
    h.delay_puts(Some(("link-estimate-alias", Duration::from_secs(60))));
    let _interrupted = h.sweep(&h.input, "restart").await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while !h
            .requests()
            .iter()
            .any(|request| is_put_of(request, &alias("restart", "Alpha")))
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("alias write starts");
    // Longer than one heartbeat interval, so the claim must have been renewed.
    tokio::time::sleep(Duration::from_secs(11)).await;
    let reply: StreamAutoClaimReply = h
        .conn
        .xautoclaim_options(
            queue::STREAM_KEY,
            queue::CONSUMER_GROUP,
            "other-worker",
            5_000,
            "0-0",
            StreamAutoClaimOptions::default(),
        )
        .await
        .unwrap();
    assert!(
        reply.claimed.is_empty(),
        "healthy worker's pending entry was not renewed"
    );

    h.delay_puts(None);
    h.restart_worker().await;
    let retry = h.sweep(&h.input, "restart").await;
    assert_eq!(h.done(&retry).await["marker_written"], true);
    assert!(h.s3.has(&alias("restart", "Alpha")));
    let ttl: i64 = h.conn.ttl(queue::state_key(&retry)).await.unwrap();
    assert!(ttl > 86_390, "terminal TTL was shortened: {ttl}");
}

#[tokio::test]
async fn publication_reconciles_cached_results_and_keeps_claims_alive() {
    let mut h = Harness::start().await;
    legacy_metadata_is_not_read(&h).await;
    failed_alias_write_withholds_marker_until_retry(&h).await;
    redis_only_results_are_published_without_solver_jobs(&h).await;
    child_fast_path_publishes_with_shared_authority(&h).await;
    legacy_payload_cannot_publish(&h).await;
    child_served_from_s3_publishes(&mut h).await;
    explicit_operator_list_cannot_publish(&h).await;
    cancelled_child_does_not_publish(&h).await;
    fresh_solves_publish_then_mark(&h).await;
    nul_in_tag_is_rejected(&h).await;
    stalled_publication_keeps_claim_and_recovers_after_restart(&mut h).await;
    baseline_publish_persists_the_result_before_its_alias(&h).await;
    baseline_alias_is_withheld_when_the_result_store_fails(&h).await;
    unauthorized_baseline_payload_publishes_nothing(&h).await;
    baseline_publish_route_round_trips(&h).await;
}

fn baseline_payload(tag: &str, is_publish_authorized: bool) -> BaselinePublishPayload {
    BaselinePublishPayload {
        input: support::canonical_two_operator_input(),
        tag: tag.into(),
        variant: BaselineVariant::Foundation,
        is_publish_authorized,
    }
}

async fn enqueue_baseline_publish(h: &Harness, payload: &BaselinePublishPayload) -> String {
    let job_id = h.store.create().await.unwrap();
    h.store
        .enqueue(&job_id, JobKind::BaselinePublish, payload)
        .await
        .unwrap();
    job_id
}

fn first_put_index(requests: &[(Method, String)], needle: &str) -> Option<usize> {
    requests
        .iter()
        .position(|(method, key)| *method == Method::PUT && key.contains(needle))
}

/// The alias is written after the hash-keyed result it points at.
async fn baseline_publish_persists_the_result_before_its_alias(h: &Harness) {
    let payload = baseline_payload("baseline-order", true);
    let before = h.requests().len();
    let result = h.done(&enqueue_baseline_publish(h, &payload).await).await;
    assert_eq!(result["alias_written"], true, "{result}");
    assert_eq!(result["tag"], "baseline-order");
    assert_eq!(result["variant"], "foundation");
    assert_eq!(result["result"]["operator_count"], 2);

    let hash = cache::hash_input(&payload.input);
    assert!(h.s3.has(&support::baseline_cache_key(hash)));
    assert!(h.s3.has(&support::baseline_alias_key("baseline-order")));
    let requests = &h.requests()[before..];
    let cache_put = first_put_index(requests, "/cache-").expect("result was put");
    let alias_put = first_put_index(requests, "baseline-alias-").expect("alias was put");
    assert!(cache_put < alias_put, "alias must follow the result");
}

/// A result store failure withholds the alias; the retry publishes from the
/// cached epoch without solving again.
async fn baseline_alias_is_withheld_when_the_result_store_fails(h: &Harness) {
    let payload = baseline_payload("baseline-retry", true);
    h.fail_puts(Some(("cache-", 403)));
    let result = h.done(&enqueue_baseline_publish(h, &payload).await).await;
    assert_eq!(result["alias_written"], false, "{result}");
    assert!(!h.s3.has(&support::baseline_alias_key("baseline-retry")));

    h.fail_puts(None);
    let result = h.done(&enqueue_baseline_publish(h, &payload).await).await;
    assert_eq!(result["alias_written"], true, "{result}");
    assert!(h.s3.has(&support::baseline_alias_key("baseline-retry")));
}

/// A payload that did not come through the ingest route stores the result
/// and nothing else.
async fn unauthorized_baseline_payload_publishes_nothing(h: &Harness) {
    let payload = baseline_payload("baseline-unauthorized", false);
    let result = h.done(&enqueue_baseline_publish(h, &payload).await).await;
    assert_eq!(result["alias_written"], false, "{result}");
    assert!(
        !h.s3
            .has(&support::baseline_alias_key("baseline-unauthorized"))
    );
    assert!(h.s3.has(&support::baseline_cache_key(cache::hash_input(
        &payload.input
    ))));
}

/// The route enqueues, the worker publishes, and the same request then
/// short-circuits on the alias.
async fn baseline_publish_route_round_trips(h: &Harness) {
    let request = || BaselinePublishRequest {
        input: support::canonical_two_operator_input(),
        tag: "baseline-route".into(),
        variant: BaselineVariant::Snapshot,
    };
    let response = routes::precompute_baseline(State(h.state.clone()), Json(request()))
        .await
        .into_response();
    assert_eq!(response.status(), 202);
    let value: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["status"], "accepted");
    assert_eq!(value["variant"], "snapshot");
    let job_id = value["job_id"].as_str().unwrap().to_owned();
    assert_eq!(h.done(&job_id).await["alias_written"], true);

    let response = routes::precompute_baseline(State(h.state.clone()), Json(request()))
        .await
        .into_response();
    assert_eq!(response.status(), 200);
    let value: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["status"], "already-cached");
    assert_eq!(value["tag"], "baseline-route");
}
