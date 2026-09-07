//! `/diff*` handlers: validate the window, read shapes from the store, run
//! the pure diff, and map [`DiffStoreError`] variants to status codes. Also
//! the two routes the Next.js cron drives: `GET /diff/missing` to learn which
//! epochs have no record, and `PUT /diff/shape/:epoch` to supply one.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use serde::{Deserialize, Serialize};
use tokio::task::{Id, JoinSet};

use crate::AppState;
use crate::diff::{
    DiffShape, EpochWindow, MAX_DIFF_EPOCH, compute_contributor_diff, compute_network_diff,
    now_rfc3339, validate_window,
};
use crate::diff_error::DiffStoreError;
use crate::diff_store::DiffStore;
use crate::epoch::{Epoch, MIN_DZ_EPOCH};

/// Concurrent shape reads for the intermediate epochs of one `GET /diff`.
pub(crate) const INTERMEDIATE_CONCURRENCY: usize = 10;
/// Deadline for one intermediate shape read. Short, because a missed
/// intermediate only degrades `first_observed_epoch`, while the Next.js proxy
/// abandons the whole request at 20 s.
pub(crate) const INTERMEDIATE_READ_TIMEOUT: Duration = Duration::from_secs(6);
/// Marks a body whose attribution was computed without every intermediate
/// epoch, so the proxy can refuse to cache it.
pub(crate) const DEGRADED_HEADER: &str = "x-diff-degraded";
/// Epochs `GET /diff/missing` inspects when `depth` is absent. Matches the 31
/// epochs `lib/utils/epoch-discovery.ts` offers in the changelog selector, so
/// the cron repairs exactly the window a user can ask for.
pub(crate) const DEFAULT_MISSING_DEPTH: u32 = 31;
/// Largest `depth` `GET /diff/missing` accepts.
pub(crate) const MAX_MISSING_DEPTH: u32 = 200;
/// Largest link count a submitted shape may carry.
pub(crate) const MAX_SHAPE_LINKS: usize = 10_000;
/// Largest contributor count a submitted shape may carry.
pub(crate) const MAX_SHAPE_CONTRIBUTORS: usize = 1_000;
/// Largest plausible link bandwidth, in Gbps.
pub(crate) const MAX_SHAPE_BANDWIDTH_GBPS: f64 = 1.0e6;

const FETCH_FAILED_MESSAGE: &str = "snapshot fetch failed";
const DEPTH_MESSAGE: &str = "depth must be an integer in [1, 200]";
const EPOCH_MESSAGE: &str = "epoch must be an integer in [48, 100000]";
const LATEST_MESSAGE: &str = "latest must be an integer in [48, 100000]";
const NO_PERSISTENCE_MESSAGE: &str = "shape store is not durable; refusing the write";

/// The diff routes, mounted by `main.rs` inside the auth-gated compute router.
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/diff", get(network_diff))
        .route("/diff/contributor/:code", get(contributor_diff))
        .route("/diff/missing", get(missing))
}

/// The ingest routes. Mounted separately by `main.rs` so a second bearer token
/// gates them on top of the compute token: writing a record every reader then
/// serves is a different power from asking for a compute.
pub fn ingest_routes() -> Router<Arc<AppState>> {
    Router::new().route("/diff/shape/:epoch", put(put_shape))
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

struct ShapeRead {
    epoch: Epoch,
    result: Result<Arc<DiffShape>, DiffStoreError>,
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

async fn load_window_ends(
    store: &Arc<DiffStore>,
    window: EpochWindow,
) -> Result<(Arc<DiffShape>, Arc<DiffShape>), DiffStoreError> {
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
                let result = match tokio::time::timeout(per_read, store.get(epoch)).await {
                    Ok(result) => result,
                    Err(_) => Err(DiffStoreError::persistence(epoch, "read deadline elapsed")),
                };
                ShapeRead { epoch, result }
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
                    result: Err(DiffStoreError::persistence(epoch, join_error)),
                });
            }
        }
    }
    reads.sort_by_key(|read| read.epoch);
    reads
}

/// Query of `GET /diff/missing`. `latest` is the caller's, because the service
/// no longer discovers epochs: all bucket knowledge lives in
/// `lib/utils/epoch-discovery.ts` on the Next.js side.
#[derive(Debug, Deserialize)]
pub(crate) struct MissingQuery {
    /// Newest epoch to consider.
    pub latest: Option<u32>,
    /// How many epochs back from `latest` to inspect; default
    /// [`DEFAULT_MISSING_DEPTH`].
    pub depth: Option<u32>,
}

/// Body of `GET /diff/missing`.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub(crate) struct MissingResponse {
    /// Epochs in the window with no record, ascending. Empty means nothing to do.
    pub missing: Vec<Epoch>,
}

/// `GET /diff/missing?latest=N&depth=D`: which epochs in the window have no
/// record. The cron reads this to decide which snapshots to download, which is
/// also the repair path for a gap left by a skipped fire or a deploy window.
async fn missing(
    State(state): State<Arc<AppState>>,
    Query(query): Query<MissingQuery>,
) -> Response {
    let Some(latest) = query.latest else {
        return error_json(StatusCode::BAD_REQUEST, LATEST_MESSAGE);
    };
    if !(MIN_DZ_EPOCH.0..=MAX_DIFF_EPOCH.0).contains(&latest) {
        return error_json(StatusCode::BAD_REQUEST, LATEST_MESSAGE);
    }
    let depth = query.depth.unwrap_or(DEFAULT_MISSING_DEPTH);
    if !(1..=MAX_MISSING_DEPTH).contains(&depth) {
        return error_json(StatusCode::BAD_REQUEST, DEPTH_MESSAGE);
    }
    match state.diff_store.missing_epochs(Epoch(latest), depth).await {
        Ok(missing) => Json(MissingResponse { missing }).into_response(),
        Err(error) => snapshot_error_response(&error),
    }
}

/// `PUT /diff/shape/:epoch`: persist one epoch's extracted shape.
///
/// Create-only, so a second write of a readable record is a 409 rather than an
/// overwrite. The body is validated before it reaches persistence: a record is
/// read by every later diff request, so a caller holding the ingest token still
/// cannot store nonsense.
async fn put_shape(
    State(state): State<Arc<AppState>>,
    Path(epoch): Path<u32>,
    Json(shape): Json<DiffShape>,
) -> Response {
    if !(MIN_DZ_EPOCH.0..=MAX_DIFF_EPOCH.0).contains(&epoch) {
        return error_json(StatusCode::BAD_REQUEST, EPOCH_MESSAGE);
    }
    let epoch = Epoch(epoch);
    // Persistence keys the object off the BODY's epoch (`store_object` calls
    // `shape_key(shape.epoch)`), so a disagreeing path would silently write to
    // another epoch's key. Refuse instead.
    if shape.epoch != epoch {
        return snapshot_error_response(&DiffStoreError::malformed(
            epoch,
            format!(
                "body names epoch {} but the path names {epoch}",
                shape.epoch
            ),
        ));
    }
    if !state.diff_store.has_durable_persistence() {
        return error_json(StatusCode::SERVICE_UNAVAILABLE, NO_PERSISTENCE_MESSAGE);
    }
    if let Err(reason) = validate_shape(&shape) {
        return snapshot_error_response(&DiffStoreError::malformed(epoch, reason));
    }
    let link_count = shape.links.len();
    let contributor_count = shape.contributors.len();
    match state.diff_store.put(shape).await {
        Ok(()) => {
            tracing::info!(
                epoch = epoch.0,
                link_count,
                contributor_count,
                "stored diff shape from ingest"
            );
            (
                StatusCode::CREATED,
                Json(MissingResponse { missing: vec![] }),
            )
                .into_response()
        }
        Err(error) => snapshot_error_response(&error),
    }
}

/// Reject a shape that cannot have come from a real snapshot. Every message is
/// safe to return: it describes the caller's own body.
fn validate_shape(shape: &DiffShape) -> Result<(), String> {
    if shape.links.is_empty() {
        return Err("links must not be empty".to_string());
    }
    if shape.links.len() > MAX_SHAPE_LINKS {
        return Err(format!("links must not exceed {MAX_SHAPE_LINKS}"));
    }
    if shape.contributors.is_empty() {
        return Err("contributors must not be empty".to_string());
    }
    if shape.contributors.len() > MAX_SHAPE_CONTRIBUTORS {
        return Err(format!(
            "contributors must not exceed {MAX_SHAPE_CONTRIBUTORS}"
        ));
    }
    let mut seen_links = std::collections::HashSet::with_capacity(shape.links.len());
    for link in &shape.links {
        if !link.bandwidth_gbps.is_finite()
            || link.bandwidth_gbps < 0.0
            || link.bandwidth_gbps > MAX_SHAPE_BANDWIDTH_GBPS
        {
            return Err(format!(
                "link {} has bandwidth_gbps {} outside [0, {MAX_SHAPE_BANDWIDTH_GBPS}]",
                link.pubkey, link.bandwidth_gbps
            ));
        }
        if !seen_links.insert(link.pubkey.as_str()) {
            return Err(format!("link {} appears twice", link.pubkey));
        }
    }
    let mut seen_codes = std::collections::HashSet::with_capacity(shape.contributors.len());
    for contributor in &shape.contributors {
        if !seen_codes.insert(contributor.code.as_str()) {
            return Err(format!("contributor {} appears twice", contributor.code));
        }
    }
    Ok(())
}

/// Status for a store failure. 5xx bodies are fixed strings; the cause goes to
/// the log. The 404 body is the error text `/changelog` already shows, so it
/// passes through verbatim.
pub(crate) fn snapshot_error_response(error: &DiffStoreError) -> Response {
    match error {
        DiffStoreError::NotFound { .. } => error_json(StatusCode::NOT_FOUND, error.to_string()),
        DiffStoreError::Conflict { .. } => error_json(StatusCode::CONFLICT, error.to_string()),
        DiffStoreError::Malformed { .. } => error_json(StatusCode::BAD_REQUEST, error.to_string()),
        DiffStoreError::Persistence { .. } => {
            tracing::error!(error = ?error, "diff: shape store failed");
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
    use serde_json::{Value, json};
    use tokio::sync::RwLock;
    use tower::ServiceExt;

    use super::*;
    use crate::diff::{ContributorRef, LinkRef};
    use crate::diff_store::NoPersistence;
    use crate::diff_store::test_support::MemoryPersistence;

    /// One epoch's shape. `extra_link` adds a second link so consecutive
    /// epochs differ, which is what makes a diff non-empty.
    fn shape(epoch: u32, extra_link: bool) -> DiffShape {
        let mut links = vec![LinkRef {
            pubkey: "K1".to_string(),
            contributor_code: "alpha".to_string(),
            side_a_code: "nyc".to_string(),
            side_z_code: "lon".to_string(),
            bandwidth_gbps: 10.0,
            link_type: "WAN".to_string(),
        }];
        if extra_link {
            links.push(LinkRef {
                pubkey: "K2".to_string(),
                contributor_code: "beta".to_string(),
                side_a_code: "fra".to_string(),
                side_z_code: "ams".to_string(),
                bandwidth_gbps: 40.0,
                link_type: "WAN".to_string(),
            });
        }
        let mut contributors = vec![ContributorRef {
            code: "alpha".to_string(),
            link_count: 1,
            device_count: 1,
            metro_count: 1,
        }];
        if extra_link {
            contributors.push(ContributorRef {
                code: "beta".to_string(),
                link_count: 1,
                device_count: 1,
                metro_count: 1,
            });
        }
        DiffShape {
            epoch: Epoch(epoch),
            links,
            contributors,
        }
    }

    fn state_with(persistence: Arc<MemoryPersistence>) -> Arc<AppState> {
        Arc::new(AppState {
            epoch_cache: RwLock::new(None),
            s3_cache: None,
            api_token: None,
            ingest_token: None,
            jobs: None,
            diff_store: Arc::new(DiffStore::new(persistence)),
        })
    }

    /// A store holding an identical shape for each named epoch.
    fn state_over(epochs: &[u32]) -> Arc<AppState> {
        let persistence = Arc::new(MemoryPersistence::default());
        for &epoch in epochs {
            persistence.insert(shape(epoch, false));
        }
        state_with(persistence)
    }

    fn state_without_persistence() -> Arc<AppState> {
        Arc::new(AppState {
            epoch_cache: RwLock::new(None),
            s3_cache: None,
            api_token: None,
            ingest_token: None,
            jobs: None,
            diff_store: Arc::new(DiffStore::new(Arc::new(NoPersistence))),
        })
    }

    async fn read_json(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body collects")
            .to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
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
        read_json(response).await
    }

    async fn put_shape_call(state: Arc<AppState>, epoch: u32, body: Value) -> (StatusCode, Value) {
        let response = ingest_routes()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/diff/shape/{epoch}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .expect("request builds"),
            )
            .await
            .expect("router answers");
        read_json(response).await
    }

    #[tokio::test]
    async fn network_diff_answers_a_valid_window() {
        let (status, body) = call(state_over(&[48, 49, 50]), "GET", "/diff?from=48&to=50").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["from"], 48);
        assert_eq!(body["to"], 50);
        assert_eq!(body["summary"]["linksAdded"], 0);
        assert!(body["fetchedAt"].is_string());
    }

    #[tokio::test]
    async fn network_diff_reports_a_link_added_between_the_ends() {
        let persistence = Arc::new(MemoryPersistence::default());
        persistence.insert(shape(48, false));
        persistence.insert(shape(49, true));
        let (status, body) = call(state_with(persistence), "GET", "/diff?from=48&to=49").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["summary"]["linksAdded"], 1);
    }

    #[tokio::test]
    async fn an_epoch_with_no_record_is_a_404_carrying_the_ui_text() {
        let (status, body) = call(state_over(&[48]), "GET", "/diff?from=48&to=60").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "epoch 60: snapshot HTTP 404");
    }

    #[tokio::test]
    async fn window_validation_emits_the_route_messages() {
        let state = state_over(&[48, 49]);
        let (status, body) = call(Arc::clone(&state), "GET", "/diff?from=48").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .expect("error text")
                .contains("required")
        );

        let (status, _) = call(state, "GET", "/diff?from=1&to=2").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_missing_intermediate_marks_the_body_degraded() {
        let response = routes()
            .with_state(state_over(&[48, 49, 51]))
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
                .map(|v| v.to_str().unwrap_or("")),
            Some("1"),
            "epoch 50 has no record, so attribution is incomplete"
        );
    }

    #[tokio::test]
    async fn contributor_diff_scopes_to_the_code() {
        let persistence = Arc::new(MemoryPersistence::default());
        persistence.insert(shape(48, false));
        persistence.insert(shape(49, true));
        let (status, body) = call(
            state_with(persistence),
            "GET",
            "/diff/contributor/beta?from=48&to=49",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["code"], "beta");
    }

    #[tokio::test]
    async fn missing_lists_the_holes_in_the_window() {
        let (status, body) = call(
            state_over(&[48, 50]),
            "GET",
            "/diff/missing?latest=51&depth=4",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["missing"], json!([49, 51]));
    }

    #[tokio::test]
    async fn missing_requires_a_latest_and_bounds_the_depth() {
        let state = state_over(&[48]);
        let (status, body) = call(Arc::clone(&state), "GET", "/diff/missing").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], LATEST_MESSAGE);

        let (status, body) = call(Arc::clone(&state), "GET", "/diff/missing?latest=1").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], LATEST_MESSAGE);

        let (status, body) = call(state, "GET", "/diff/missing?latest=200&depth=201").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], DEPTH_MESSAGE);
    }

    #[tokio::test]
    async fn put_shape_creates_then_conflicts() {
        let persistence = Arc::new(MemoryPersistence::default());
        let state = state_with(Arc::clone(&persistence));
        let body = serde_json::to_value(shape(204, false)).expect("shape serializes");

        let (status, _) = put_shape_call(Arc::clone(&state), 204, body.clone()).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(persistence.store_calls(), 1);

        let (status, error) = put_shape_call(state, 204, body).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error["error"], "epoch 204: shape already persisted");
        assert_eq!(persistence.store_calls(), 1, "the conflict wrote nothing");
    }

    #[tokio::test]
    async fn put_shape_refuses_a_body_naming_another_epoch() {
        // Persistence keys the object off the BODY's epoch, so a disagreeing
        // path would write to epoch 210's key under a 211 request.
        let state = state_with(Arc::new(MemoryPersistence::default()));
        let body = serde_json::to_value(shape(210, false)).expect("shape serializes");
        let (status, error) = put_shape_call(state, 211, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            error["error"],
            "epoch 211: body names epoch 210 but the path names 211"
        );
    }

    #[tokio::test]
    async fn put_shape_rejects_an_out_of_range_epoch() {
        let state = state_with(Arc::new(MemoryPersistence::default()));
        let body = serde_json::to_value(shape(47, false)).expect("shape serializes");
        let (status, error) = put_shape_call(state, 47, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"], EPOCH_MESSAGE);
    }

    #[tokio::test]
    async fn put_shape_rejects_bodies_that_cannot_come_from_a_snapshot() {
        let state = state_with(Arc::new(MemoryPersistence::default()));

        let mut empty = shape(204, false);
        empty.links.clear();
        let (status, error) = put_shape_call(
            Arc::clone(&state),
            204,
            serde_json::to_value(&empty).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"], "epoch 204: links must not be empty");

        let mut no_contributors = shape(204, false);
        no_contributors.contributors.clear();
        let (status, error) = put_shape_call(
            Arc::clone(&state),
            204,
            serde_json::to_value(&no_contributors).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"], "epoch 204: contributors must not be empty");

        let mut duplicate = shape(204, true);
        duplicate.links[1].pubkey = "K1".to_string();
        let (status, error) = put_shape_call(
            Arc::clone(&state),
            204,
            serde_json::to_value(&duplicate).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"], "epoch 204: link K1 appears twice");

        // NaN survives serde_json as `null`, so drive the check through a
        // literal body rather than a serialized struct.
        let mut huge = shape(204, false);
        huge.links[0].bandwidth_gbps = 1.0e9;
        let (status, error) =
            put_shape_call(state, 204, serde_json::to_value(&huge).unwrap()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            error["error"]
                .as_str()
                .expect("error text")
                .contains("outside [0, 1000000]"),
            "got {error:?}"
        );
    }

    #[tokio::test]
    async fn put_shape_refuses_when_persistence_would_not_survive_a_restart() {
        let body = serde_json::to_value(shape(204, false)).expect("shape serializes");
        let (status, _) = put_shape_call(state_without_persistence(), 204, body).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn store_errors_map_onto_the_statuses_the_proxy_expects() {
        let epoch = Epoch(204);
        let cases = [
            (DiffStoreError::NotFound { epoch }, StatusCode::NOT_FOUND),
            (DiffStoreError::Conflict { epoch }, StatusCode::CONFLICT),
            (
                DiffStoreError::malformed(epoch, "bad"),
                StatusCode::BAD_REQUEST,
            ),
            (
                DiffStoreError::persistence(epoch, "gateway down"),
                StatusCode::BAD_GATEWAY,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(snapshot_error_response(&error).status(), expected);
        }
    }
}
