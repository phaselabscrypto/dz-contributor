//! `/diff*` handlers: validate the window, read shapes from the store, run
//! the pure diff, and map `SnapshotError` variants to status codes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tokio::task::{Id, JoinSet};

use crate::AppState;
use crate::diff::{
    DiffShape, EpochWindow, MAX_DIFF_EPOCH, compute_contributor_diff, compute_network_diff,
    now_rfc3339, validate_window,
};
use crate::diff_store::DiffStore;
use crate::snapshot::{Epoch, MIN_DZ_EPOCH, SNAPSHOT_FETCH_TIMEOUT, SnapshotError};

/// Concurrent shape reads for the intermediate epochs of one `GET /diff`.
pub(crate) const INTERMEDIATE_CONCURRENCY: usize = 10;
/// Concurrent shape reads for one `POST /diff/precompute`.
pub(crate) const PRECOMPUTE_CONCURRENCY: usize = 3;
/// Deadline for one intermediate shape read. Short, because a missed
/// intermediate only degrades `first_observed_epoch`, while the Next.js proxy
/// abandons the whole request at 20 s.
pub(crate) const INTERMEDIATE_READ_TIMEOUT: Duration = Duration::from_secs(6);
/// Deadline for one shape read in a precompute, which exists to pay the
/// cold-ingest cost and so gets the full snapshot budget.
pub(crate) const PRECOMPUTE_READ_TIMEOUT: Duration = SNAPSHOT_FETCH_TIMEOUT;
/// Marks a body whose attribution was computed without every intermediate
/// epoch, so the proxy can refuse to cache it.
pub(crate) const DEGRADED_HEADER: &str = "x-diff-degraded";
/// Epochs warmed by `POST /diff/precompute` when `depth` is absent.
pub(crate) const DEFAULT_PRECOMPUTE_DEPTH: u32 = 8;
/// Largest `depth` `POST /diff/precompute` accepts.
pub(crate) const MAX_PRECOMPUTE_DEPTH: u32 = 30;

const FETCH_FAILED_MESSAGE: &str = "snapshot fetch failed";
const SCAN_FAILED_MESSAGE: &str = "snapshot scan failed";
const DEPTH_MESSAGE: &str = "depth must be an integer in [1, 30]";
const EPOCH_MESSAGE: &str = "epoch must be an integer in [48, 100000]";

/// The diff routes, mounted by `main.rs` inside the auth-gated compute router.
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/diff", get(network_diff))
        .route("/diff/contributor/:code", get(contributor_diff))
        .route("/diff/precompute", post(precompute))
}

/// Query of `GET /diff` and `GET /diff/contributor/:code`. Raw strings so
/// [`validate_window`] emits the exact messages the UI shows.
#[derive(Debug, Deserialize)]
pub(crate) struct WindowQuery {
    /// The `before` epoch.
    pub from: Option<String>,
    /// The `after` epoch.
    pub to: Option<String>,
}

/// Query of `POST /diff/precompute`. `epoch` wins over `depth`.
#[derive(Debug, Deserialize)]
pub(crate) struct PrecomputeQuery {
    /// Warm exactly this epoch.
    pub epoch: Option<u32>,
    /// Warm the `depth` most recent epochs; default [`DEFAULT_PRECOMPUTE_DEPTH`].
    pub depth: Option<u32>,
}

/// Outcome of one epoch in a precompute.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PrecomputeStatus {
    /// The shape is now in memory.
    Ok,
    /// The bucket has no snapshot for the epoch.
    Missing,
    /// Fetch or scan failed; the cause is in the log.
    Error,
}

/// One row of a precompute report.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub(crate) struct PrecomputeResult {
    /// The epoch warmed.
    pub epoch: Epoch,
    /// What happened.
    pub status: PrecomputeStatus,
    /// Wall time of the read in milliseconds.
    pub ms: u128,
}

/// Body of `POST /diff/precompute`.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub(crate) struct PrecomputeResponse {
    /// The discovered latest epoch; `None` when `epoch` was given.
    pub latest: Option<Epoch>,
    /// One row per target epoch, ascending.
    pub results: Vec<PrecomputeResult>,
}

struct ShapeRead {
    epoch: Epoch,
    result: Result<Arc<DiffShape>, SnapshotError>,
    elapsed: Duration,
}

/// `GET /diff?from&to`: network-wide diff with change attribution over the
/// intermediate epochs. An intermediate that fails to load is skipped.
async fn network_diff(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WindowQuery>,
) -> Response {
    let window = match validate_window(query.from.as_deref(), query.to.as_deref()) {
        Ok(window) => window,
        Err(message) => return error_json(StatusCode::BAD_REQUEST, message),
    };
    let (before, after) = match load_window_ends(&state.diff_store, window).await {
        Ok(ends) => ends,
        Err(error) => return snapshot_error_response(&error),
    };
    let (intermediates, skipped) = load_intermediates(&state.diff_store, window).await;
    let mut response = Json(compute_network_diff(
        &before,
        &after,
        &intermediates,
        now_rfc3339(),
    ))
    .into_response();
    if skipped > 0 {
        response
            .headers_mut()
            .insert(DEGRADED_HEADER, HeaderValue::from_static("1"));
    }
    response
}

/// `GET /diff/contributor/:code?from&to`: one contributor's diff. The body
/// carries no `name`; the Next.js proxy adds it.
async fn contributor_diff(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
    Query(query): Query<WindowQuery>,
) -> Response {
    let window = match validate_window(query.from.as_deref(), query.to.as_deref()) {
        Ok(window) => window,
        Err(message) => return error_json(StatusCode::BAD_REQUEST, message),
    };
    match load_window_ends(&state.diff_store, window).await {
        Ok((before, after)) => Json(compute_contributor_diff(
            &before,
            &after,
            &code,
            now_rfc3339(),
        ))
        .into_response(),
        Err(error) => snapshot_error_response(&error),
    }
}

/// `POST /diff/precompute?epoch=N` or `?depth=D`: warm shapes into memory
/// and persistence. 502 only when every target epoch errored.
async fn precompute(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PrecomputeQuery>,
) -> Response {
    let (latest, targets) = match precompute_targets(&state.diff_store, &query).await {
        Ok(plan) => plan,
        Err(response) => return response,
    };
    let reads = read_bounded(
        &state.diff_store,
        targets,
        PRECOMPUTE_CONCURRENCY,
        PRECOMPUTE_READ_TIMEOUT,
    )
    .await;
    let results: Vec<PrecomputeResult> = reads
        .iter()
        .map(|read| PrecomputeResult {
            epoch: read.epoch,
            status: precompute_status(read),
            ms: read.elapsed.as_millis(),
        })
        .collect();
    let has_only_errors = !results.is_empty()
        && results
            .iter()
            .all(|result| result.status == PrecomputeStatus::Error);
    if has_only_errors {
        return error_json(StatusCode::BAD_GATEWAY, FETCH_FAILED_MESSAGE);
    }
    Json(PrecomputeResponse { latest, results }).into_response()
}

/// Epochs a precompute warms: `[epoch]`, or the `depth` most recent epochs
/// ending at the latest, never below `MIN_DZ_EPOCH`.
pub(crate) fn precompute_epochs(latest: Epoch, depth: u32) -> Vec<Epoch> {
    let first = latest
        .0
        .saturating_sub(depth.saturating_sub(1))
        .max(MIN_DZ_EPOCH.0);
    (first..=latest.0).map(Epoch).collect()
}

async fn precompute_targets(
    store: &Arc<DiffStore>,
    query: &PrecomputeQuery,
) -> Result<(Option<Epoch>, Vec<Epoch>), Response> {
    if let Some(epoch) = query.epoch {
        if !(MIN_DZ_EPOCH.0..=MAX_DIFF_EPOCH.0).contains(&epoch) {
            return Err(error_json(StatusCode::BAD_REQUEST, EPOCH_MESSAGE));
        }
        return Ok((None, vec![Epoch(epoch)]));
    }
    let depth = query.depth.unwrap_or(DEFAULT_PRECOMPUTE_DEPTH);
    if !(1..=MAX_PRECOMPUTE_DEPTH).contains(&depth) {
        return Err(error_json(StatusCode::BAD_REQUEST, DEPTH_MESSAGE));
    }
    let latest = store
        .latest_epoch()
        .await
        .map_err(|error| snapshot_error_response(&error))?;
    Ok((Some(latest), precompute_epochs(latest, depth)))
}

fn precompute_status(read: &ShapeRead) -> PrecomputeStatus {
    match &read.result {
        Ok(_) => PrecomputeStatus::Ok,
        Err(SnapshotError::NotFound { .. }) => PrecomputeStatus::Missing,
        Err(error) => {
            tracing::error!(epoch = read.epoch.0, error = %error, "diff precompute: epoch failed");
            PrecomputeStatus::Error
        }
    }
}

async fn load_window_ends(
    store: &Arc<DiffStore>,
    window: EpochWindow,
) -> Result<(Arc<DiffShape>, Arc<DiffShape>), SnapshotError> {
    let (before, after) = tokio::join!(store.get(window.from), store.get(window.to));
    Ok((before?, after?))
}

/// Shapes for `from+1 ..= to-1`, ascending, with the number that could not be
/// read. Empty when `from >= to - 1`.
async fn load_intermediates(
    store: &Arc<DiffStore>,
    window: EpochWindow,
) -> (Vec<Arc<DiffShape>>, usize) {
    let epochs = (window.from.0.saturating_add(1)..window.to.0).map(Epoch);
    let reads = read_bounded(
        store,
        epochs,
        INTERMEDIATE_CONCURRENCY,
        INTERMEDIATE_READ_TIMEOUT,
    )
    .await;
    let mut shapes = Vec::with_capacity(reads.len());
    let mut skipped = 0usize;
    for read in reads {
        match read.result {
            Ok(shape) => shapes.push(shape),
            Err(error) => {
                skipped += 1;
                tracing::warn!(epoch = read.epoch.0, error = %error,
                    "diff: intermediate epoch skipped");
            }
        }
    }
    (shapes, skipped)
}

/// Read every epoch through the store with at most `concurrency` reads in
/// flight, each bounded by `per_read`. Results come back ascending by epoch.
async fn read_bounded(
    store: &Arc<DiffStore>,
    epochs: impl IntoIterator<Item = Epoch>,
    concurrency: usize,
    per_read: Duration,
) -> Vec<ShapeRead> {
    let mut pending = epochs.into_iter();
    let mut tasks: JoinSet<ShapeRead> = JoinSet::new();
    let mut epoch_by_task: HashMap<Id, Epoch> = HashMap::new();
    let mut reads = Vec::new();
    loop {
        while tasks.len() < concurrency.max(1)
            && let Some(epoch) = pending.next()
        {
            let store = Arc::clone(store);
            let handle = tasks.spawn(async move {
                let started = Instant::now();
                let result = match tokio::time::timeout(per_read, store.get(epoch)).await {
                    Ok(result) => result,
                    Err(_) => Err(SnapshotError::Timeout { epoch }),
                };
                ShapeRead {
                    epoch,
                    result,
                    elapsed: started.elapsed(),
                }
            });
            epoch_by_task.insert(handle.id(), epoch);
        }
        let Some(joined) = tasks.join_next_with_id().await else {
            break;
        };
        match joined {
            Ok((id, read)) => {
                epoch_by_task.remove(&id);
                reads.push(read);
            }
            Err(join_error) => {
                let Some(epoch) = epoch_by_task.remove(&join_error.id()) else {
                    continue;
                };
                tracing::error!(epoch = epoch.0, error = %join_error,
                    "diff: shape read task failed");
                reads.push(ShapeRead {
                    epoch,
                    result: Err(SnapshotError::Transport {
                        epoch,
                        message: join_error.to_string(),
                    }),
                    elapsed: Duration::ZERO,
                });
            }
        }
    }
    reads.sort_by_key(|read| read.epoch);
    reads
}

/// Status for a store failure. 5xx bodies are fixed strings; the cause goes
/// to the log. The 404 body is the error text the UI already shows.
pub(crate) fn snapshot_error_response(error: &SnapshotError) -> Response {
    match error {
        SnapshotError::NotFound { .. } => error_json(StatusCode::NOT_FOUND, error.to_string()),
        SnapshotError::Scan { .. } => {
            tracing::error!(error = %error, "diff: snapshot scan failed");
            error_json(StatusCode::UNPROCESSABLE_ENTITY, SCAN_FAILED_MESSAGE)
        }
        SnapshotError::Http { .. }
        | SnapshotError::Transport { .. }
        | SnapshotError::Timeout { .. } => {
            tracing::error!(error = %error, "diff: snapshot fetch failed");
            error_json(StatusCode::BAD_GATEWAY, FETCH_FAILED_MESSAGE)
        }
    }
}

fn error_json(status: StatusCode, message: impl Into<String>) -> Response {
    let message: String = message.into();
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tokio::sync::RwLock;
    use tower::ServiceExt;

    use super::*;
    use crate::diff_store::NoPersistence;
    use crate::diff_store::test_support::{FakeReader, MemoryPersistence};
    use crate::snapshot::ScanFailure;

    fn state_over(reader: Arc<FakeReader>) -> Arc<AppState> {
        Arc::new(AppState {
            epoch_cache: RwLock::new(None),
            s3_cache: None,
            api_token: None,
            jobs: None,
            diff_store: Arc::new(DiffStore::new(
                reader,
                Arc::new(MemoryPersistence::default()),
            )),
        })
    }

    async fn call(state: Arc<AppState>, method: &str, uri: &str) -> (StatusCode, Value) {
        let response = routes()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .expect("request builds"),
            )
            .await
            .expect("router answers");
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body collects")
            .to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn network_diff_answers_a_valid_window() {
        let state = state_over(Arc::new(FakeReader::with_epochs([48, 49, 50])));
        let (status, body) = call(state, "GET", "/diff?from=48&to=50").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["from"], 48);
        assert_eq!(body["to"], 50);
        assert_eq!(body["summary"]["linksAdded"], 0);
        assert!(body["fetchedAt"].is_string());
    }

    #[tokio::test]
    async fn network_diff_rejects_a_bad_window_and_reports_a_missing_epoch() {
        let state = state_over(Arc::new(FakeReader::with_epochs([48, 49])));
        let (status, body) = call(Arc::clone(&state), "GET", "/diff?from=1&to=2").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "from and to must be in [48, 100000]");

        let (status, body) = call(state, "GET", "/diff?from=48&to=200").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "epoch 200: snapshot HTTP 404");
    }

    #[tokio::test]
    async fn contributor_diff_omits_the_display_name() {
        let state = state_over(Arc::new(FakeReader::with_epochs([48, 49])));
        let (status, body) = call(state, "GET", "/diff/contributor/alpha?from=48&to=49").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["code"], "alpha");
        assert!(body.get("name").is_none());
        assert_eq!(body["footprint"]["after"]["linkCount"], 1);
    }

    #[tokio::test]
    async fn precompute_by_epoch_and_by_depth() {
        let reader = Arc::new(FakeReader::with_epochs([48, 49, 50, 51]));
        let state = state_over(Arc::clone(&reader));
        let (status, body) = call(Arc::clone(&state), "POST", "/diff/precompute?epoch=49").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["latest"].is_null());
        assert_eq!(body["results"].as_array().map(Vec::len), Some(1));
        assert_eq!(body["results"][0]["status"], "ok");
        assert_eq!(reader.fetch_calls(), 1);

        let (status, body) = call(Arc::clone(&state), "POST", "/diff/precompute?depth=3").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["latest"], 51);
        let epochs: Vec<u64> = body["results"]
            .as_array()
            .expect("results array")
            .iter()
            .map(|row| row["epoch"].as_u64().expect("epoch number"))
            .collect();
        assert_eq!(epochs, vec![49, 50, 51]);
        assert_eq!(reader.fetch_calls(), 3);

        let (status, body) = call(Arc::clone(&state), "POST", "/diff/precompute?depth=31").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], DEPTH_MESSAGE);

        let (status, body) = call(state, "POST", "/diff/precompute?epoch=1").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], EPOCH_MESSAGE);
    }

    #[tokio::test]
    async fn precompute_reports_missing_and_fails_only_when_every_epoch_errored() {
        let reader = Arc::new(FakeReader::with_epochs([48]));
        let state = state_over(Arc::clone(&reader));
        let (status, body) = call(Arc::clone(&state), "POST", "/diff/precompute?epoch=60").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["results"][0]["status"], "missing");

        reader.fail_next_fetches(1);
        let (status, body) = call(state, "POST", "/diff/precompute?epoch=48").await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(body["error"], FETCH_FAILED_MESSAGE);
    }

    #[test]
    fn precompute_epochs_count_back_from_latest_and_clamp() {
        assert_eq!(
            precompute_epochs(Epoch(211), 3),
            vec![Epoch(209), Epoch(210), Epoch(211)]
        );
        assert_eq!(precompute_epochs(Epoch(211), 1), vec![Epoch(211)]);
        assert_eq!(precompute_epochs(Epoch(49), 30), vec![Epoch(48), Epoch(49)]);
    }

    #[tokio::test]
    async fn read_bounded_keeps_epoch_order_and_skipped_intermediates_do_not_fail() {
        let reader = Arc::new(FakeReader::with_epochs([48, 49, 50, 51, 52]));
        let store = Arc::new(DiffStore::new(
            Arc::clone(&reader) as Arc<dyn crate::snapshot::SnapshotReader>,
            Arc::new(NoPersistence),
        ));
        let reads = read_bounded(&store, (48..=52).map(Epoch), 2, INTERMEDIATE_READ_TIMEOUT).await;
        let epochs: Vec<Epoch> = reads.iter().map(|read| read.epoch).collect();
        assert_eq!(epochs, (48..=52).map(Epoch).collect::<Vec<_>>());
        assert!(reads.iter().all(|read| read.result.is_ok()));

        let window = EpochWindow {
            from: Epoch(48),
            to: Epoch(55),
        };
        let (intermediates, skipped) = load_intermediates(&store, window).await;
        let epochs: Vec<Epoch> = intermediates.iter().map(|shape| shape.epoch).collect();
        assert_eq!(epochs, vec![Epoch(49), Epoch(50), Epoch(51), Epoch(52)]);
        assert_eq!(skipped, 2, "epochs 53 and 54 have no snapshot");
    }

    #[tokio::test]
    async fn a_skipped_intermediate_marks_the_body_degraded() {
        let reader = Arc::new(FakeReader::with_epochs([48, 49, 51]));
        let state = state_over(Arc::clone(&reader));

        let response = routes()
            .with_state(Arc::clone(&state))
            .oneshot(
                Request::builder()
                    .uri("/diff?from=48&to=51")
                    .body(Body::empty())
                    .expect("request builds"),
            )
            .await
            .expect("router answers");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(DEGRADED_HEADER)
                .map(|v| v.as_bytes()),
            Some(b"1".as_slice()),
            "epoch 50 is absent, so attribution fell back to `to`"
        );

        let (status, body) = call(state, "GET", "/diff?from=48&to=49").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["to"], 49, "a window with no intermediates is complete");
    }

    #[test]
    fn snapshot_errors_map_to_status_codes() {
        let epoch = Epoch(5);
        let cases = [
            (SnapshotError::NotFound { epoch }, StatusCode::NOT_FOUND),
            (
                SnapshotError::Http { epoch, status: 500 },
                StatusCode::BAD_GATEWAY,
            ),
            (
                SnapshotError::Transport {
                    epoch,
                    message: "x".to_string(),
                },
                StatusCode::BAD_GATEWAY,
            ),
            (SnapshotError::Timeout { epoch }, StatusCode::BAD_GATEWAY),
            (
                SnapshotError::Scan {
                    epoch,
                    bytes_read: 1,
                    failure: ScanFailure::Truncated,
                },
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(
                snapshot_error_response(&error).status(),
                expected,
                "{error}"
            );
        }
    }
}
