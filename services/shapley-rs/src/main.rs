//! HTTP wrapper around the canonical `network-shapley` Rust crate.
//!
//! Endpoints:
//! - `GET  /health`            -> liveness + crate version
//! - `POST /shapley`           -> compute Shapley values for a coalition input
//! - `POST /link-estimate`     -> per-link value-add for a focused operator
//! - `GET  /diff`              -> network diff between two epochs
//! - `GET  /diff/contributor/:code` -> one contributor's diff between two epochs
//! - `POST /jobs/link-estimate/by-tag` -> serve a precomputed estimate by epoch
//! - `GET  /diff/missing`      -> epochs in a window with no persisted shape
//! - `PUT  /diff/shape/:epoch` -> ingest one epoch's shape (second bearer token)

use std::sync::Arc;

use dz_shapley_service::AppState;
use dz_shapley_service::cache::S3Cache;
use dz_shapley_service::diff_store::{
    DiffStore, NoPersistence, S3ShapePersistence, ShapePersistence,
};
use dz_shapley_service::{diff_routes, routes};

use axum::{
    Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::net::SocketAddr;
use std::time::Duration;

/// Header carrying the ingest token. Separate from `Authorization`, which
/// already carries the compute token on the same request.
const INGEST_TOKEN_HEADER: &str = "x-ingest-token";
use tokio::sync::RwLock;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::CorsLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=debug".into()))
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    // Role select (ADR 0001 Phase 2): `api` runs the HTTP server (default);
    // `worker` runs the Redis-Stream consume loop. Accept either a bare
    // subcommand (`worker`) or `--role=worker` so container `args:` are flexible.
    let role = std::env::args().nth(1).unwrap_or_else(|| "api".to_string());

    // ── Shared state for both roles ──────────────────────────────────────
    // S3 cache is a no-op when S3_CACHE_BUCKET is unset.
    let s3_cache = S3Cache::new().await;
    let shape_persistence: Arc<dyn ShapePersistence> = match &s3_cache {
        Some(cache) => Arc::new(S3ShapePersistence::from(cache.handle())),
        None => Arc::new(NoPersistence),
    };
    let diff_store = Arc::new(DiffStore::new(shape_persistence));
    // Compute-endpoint auth posture, resolved once and FAIL-CLOSED by default.
    // Production sets `SHAPLEY_API_TOKEN` via a Secret. With no token, the
    // compute endpoints are served ONLY when `SHAPLEY_ALLOW_UNAUTHENTICATED=1`
    // is set explicitly — so an operator can never accidentally run an open,
    // internet-reachable solver by merely forgetting the token.
    let api_token = std::env::var("SHAPLEY_API_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());
    let allow_unauthenticated =
        std::env::var("SHAPLEY_ALLOW_UNAUTHENTICATED").is_ok_and(|v| v == "1");
    // Separate from `api_token` on purpose. The compute token buys a compute;
    // this one buys a write that every later reader is served. Unset means the
    // ingest routes answer 503, never "pass through" — an unset compute token
    // is a local-dev convenience, an unset write token is an open door.
    let ingest_token = std::env::var("SHAPLEY_INGEST_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());
    if ingest_token.is_none() {
        tracing::warn!(
            "SHAPLEY_INGEST_TOKEN unset — PUT /diff/shape/:epoch will answer 503 and the \
             diff index will not accept new epochs"
        );
    }
    let serve_compute = match (api_token.is_some(), allow_unauthenticated) {
        (true, _) => {
            tracing::info!("compute endpoints require bearer-token auth");
            true
        }
        (false, true) => {
            tracing::warn!(
                "SHAPLEY_API_TOKEN unset + SHAPLEY_ALLOW_UNAUTHENTICATED=1 — compute \
                 endpoints are UNAUTHENTICATED (intended for local dev only)"
            );
            true
        }
        (false, false) => {
            tracing::error!(
                "SHAPLEY_API_TOKEN unset and SHAPLEY_ALLOW_UNAUTHENTICATED not set — refusing \
                 to serve compute endpoints (only /health). Set SHAPLEY_API_TOKEN to require \
                 auth, or SHAPLEY_ALLOW_UNAUTHENTICATED=1 to run open locally."
            );
            false
        }
    };
    let state = Arc::new(AppState {
        epoch_cache: RwLock::new(None),
        s3_cache,
        api_token,
        ingest_token,
        jobs: dz_shapley_service::jobs::store_from_env(),
        diff_store,
    });

    match role.as_str() {
        "api" | "--role=api" => run_api(state, serve_compute).await,
        "worker" | "--role=worker" => run_worker(state).await,
        other => {
            anyhow::bail!("unknown role {other:?}, expected `api` or `worker`")
        }
    }
}

/// API role: HTTP server — synchronous compute endpoints plus the async
/// `/jobs/*` enqueue/poll/cancel surface. The heavy what-if solve is enqueued
/// for the worker pool rather than run here.
async fn run_api(state: Arc<AppState>, serve_compute: bool) -> anyhow::Result<()> {
    let cors = build_cors();

    // `/health` is always open for probes. The compute routes are mounted ONLY
    // when the auth posture permits (token set, or explicit dev opt-in — see
    // `main`); absent both, they are not served at all (fail-closed).
    let mut app = Router::new().route("/health", get(routes::health));

    if serve_compute {
        let compute_routes = Router::new()
            .route("/shapley", post(routes::shapley))
            .route("/simulate", post(routes::simulate))
            .route("/link-estimate", post(routes::link_estimate))
            .route("/precompute", post(routes::precompute))
            .route(
                "/precompute/link-estimates",
                post(routes::link_estimate_sweep),
            )
            .route(
                "/precompute/link-estimates/status",
                get(routes::link_estimate_sweep_status),
            )
            // Async jobs: enqueue → poll progress → cancel. `/jobs/:id` status +
            // cancel are shared across job kinds (what-if + link-estimate).
            .route("/jobs/simulate", post(routes::simulate_start))
            .route("/jobs/link-estimate", post(routes::link_estimate_start))
            .route(
                "/jobs/link-estimate/by-tag",
                post(routes::link_estimate_start_by_tag),
            )
            .route(
                "/jobs/:id",
                get(routes::job_status).delete(routes::job_cancel),
            )
            .merge(diff_routes::routes())
            // Merged BEFORE `route_layer`, so the compute token applies here
            // too and a write must clear both gates: `require_auth` outermost,
            // then `require_ingest_auth`.
            .merge(
                diff_routes::ingest_routes().route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    require_ingest_auth,
                )),
            )
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));
        app = app.merge(compute_routes);
    }

    let app = app
        .with_state(state)
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::new(Duration::from_secs(120)))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024)) // 2 MB
        .layer(CatchPanicLayer::new())
        .layer(cors);

    let addr = SocketAddr::from(([0, 0, 0, 0], bind_port()));
    tracing::info!(%addr, "starting dz-shapley-service (api)");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// Worker role: a minimal `/health` listener for K8s probes, the Stream
/// consume loop, and the diff index poller, raced by one `select!`. The health
/// server and the consume loop share a graceful-shutdown signal, so a SIGTERM
/// stops accepting and lets the in-flight solve wind down (the
/// terminationGracePeriod). Anything interrupted is recovered by the worker's
/// XAUTOCLAIM sweep under at-least-once delivery, made safe by the result
/// cache. The poller has no such signal: a SIGTERM drops it mid-ingest, which
/// is safe because a shape is written in one PUT and the next tick refills.
async fn run_worker(state: Arc<AppState>) -> anyhow::Result<()> {
    let health = Router::new().route("/health", get(routes::health));
    let addr = SocketAddr::from(([0, 0, 0, 0], bind_port()));
    tracing::info!(%addr, "starting dz-shapley-service (worker)");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let server = axum::serve(listener, health).with_graceful_shutdown(shutdown_signal());

    tokio::select! {
        r = server => {
            r?;
            tracing::info!("worker health server stopped");
        }
        r = dz_shapley_service::worker::run(Arc::clone(&state)) => {
            match r {
                Ok(()) => tracing::info!("worker loop exited"),
                Err(e) => {
                    tracing::error!(error = %e, "worker loop failed");
                    return Err(e);
                }
            }
        }
    }
    Ok(())
}

/// Resolve the HTTP listen port (`PORT` env, default 8080) — shared by both roles.
fn bind_port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080)
}

/// Build CORS layer from `CORS_ORIGIN` env var.
///
/// - If `CORS_ORIGIN` is set (e.g. `https://your-app.example.com`), only that
///   origin is allowed.
/// - If unset, NO cross-origin requests are allowed (same-origin only) — the
///   safe default for a public, internet-reachable service. (The frontend
///   reaches this service through a server-side proxy, not the browser, so it
///   is unaffected by CORS regardless.)
///
/// Methods are restricted to GET + POST (the only verbs this service uses).
fn build_cors() -> CorsLayer {
    use axum::http::{HeaderName, Method};

    let methods = vec![Method::GET, Method::POST];
    let headers = vec![HeaderName::from_static("content-type")];

    let layer = CorsLayer::new()
        .allow_methods(methods)
        .allow_headers(headers);

    match std::env::var("CORS_ORIGIN") {
        Ok(origin) => {
            tracing::info!(%origin, "CORS locked to configured origin");
            layer.allow_origin(
                origin
                    .parse::<axum::http::HeaderValue>()
                    .expect("CORS_ORIGIN must be a valid header value"),
            )
        }
        Err(_) => {
            tracing::warn!(
                "CORS_ORIGIN not set — no cross-origin requests allowed (same-origin only)"
            );
            layer
        }
    }
}

/// Auth middleware for the compute endpoints. Requires
/// `Authorization: Bearer <SHAPLEY_API_TOKEN>` when a token is configured;
/// passes through when no token is set (local dev).
async fn require_auth(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(expected) = state.api_token.as_deref() else {
        return next.run(request).await;
    };
    let provided = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    match provided {
        Some(token) if ct_eq(token.as_bytes(), expected.as_bytes()) => next.run(request).await,
        _ => (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
    }
}

/// Auth middleware for the ingest routes, layered UNDER [`require_auth`] so a
/// write needs both tokens.
///
/// Unlike [`require_auth`], an unset token refuses rather than passes through.
/// Running the solver open locally is a convenience; running a public write
/// endpoint open is not, and the routes have no other guard.
async fn require_ingest_auth(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(expected) = state.ingest_token.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "SHAPLEY_INGEST_TOKEN not configured",
        )
            .into_response();
    };
    let provided = request
        .headers()
        .get(INGEST_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok());
    match provided {
        Some(token) if ct_eq(token.as_bytes(), expected.as_bytes()) => next.run(request).await,
        _ => (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
    }
}

/// Constant-time byte comparison — avoids leaking the token via early-exit
/// timing on the first differing byte.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::put;
    use dz_shapley_service::diff_store::NoPersistence;
    use tokio::sync::RwLock;
    use tower::ServiceExt;

    use super::*;

    fn state_with_tokens(api: Option<&str>, ingest: Option<&str>) -> Arc<AppState> {
        Arc::new(AppState {
            epoch_cache: RwLock::new(None),
            s3_cache: None,
            api_token: api.map(str::to_string),
            ingest_token: ingest.map(str::to_string),
            jobs: None,
            diff_store: Arc::new(DiffStore::new(Arc::new(NoPersistence))),
        })
    }

    /// The same double gate `run_api` builds: the ingest layer merged in before
    /// the compute layer, so a write must clear both.
    fn gated_app(state: Arc<AppState>) -> Router {
        Router::new()
            .route("/probe", axum::routing::get(|| async { "compute ok" }))
            .merge(
                Router::new()
                    .route("/diff/shape/:epoch", put(|| async { "write ok" }))
                    .route_layer(middleware::from_fn_with_state(
                        state.clone(),
                        require_ingest_auth,
                    )),
            )
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state)
    }

    async fn write_status(
        state: Arc<AppState>,
        bearer: Option<&str>,
        ingest: Option<&str>,
    ) -> StatusCode {
        let mut request = Request::builder().method("PUT").uri("/diff/shape/204");
        if let Some(token) = bearer {
            request = request.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(token) = ingest {
            request = request.header(INGEST_TOKEN_HEADER, token);
        }
        gated_app(state)
            .oneshot(request.body(Body::empty()).expect("request builds"))
            .await
            .expect("router answers")
            .status()
    }

    #[tokio::test]
    async fn a_write_needs_both_tokens() {
        let state = state_with_tokens(Some("compute"), Some("ingest"));
        assert_eq!(
            write_status(Arc::clone(&state), Some("compute"), Some("ingest")).await,
            StatusCode::OK
        );
        assert_eq!(
            write_status(Arc::clone(&state), Some("compute"), None).await,
            StatusCode::UNAUTHORIZED,
            "the compute token alone must not buy a write"
        );
        assert_eq!(
            write_status(Arc::clone(&state), None, Some("ingest")).await,
            StatusCode::UNAUTHORIZED,
            "the ingest token alone must not get past compute auth"
        );
        assert_eq!(
            write_status(state, Some("compute"), Some("wrong")).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn an_unset_ingest_token_refuses_rather_than_passes_through() {
        // require_auth passes through when api_token is None, which is a local
        // dev convenience. A public write endpoint must not inherit that.
        let state = state_with_tokens(None, None);
        assert_eq!(
            write_status(Arc::clone(&state), None, None).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            write_status(state, None, Some("anything")).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn compute_routes_are_untouched_by_the_ingest_gate() {
        let state = state_with_tokens(Some("compute"), None);
        let response = gated_app(Arc::clone(&state))
            .oneshot(
                Request::builder()
                    .uri("/probe")
                    .header(AUTHORIZATION, "Bearer compute")
                    .body(Body::empty())
                    .expect("request builds"),
            )
            .await
            .expect("router answers");
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn ct_eq_rejects_a_length_mismatch_and_accepts_an_exact_match() {
        assert!(ct_eq(b"token", b"token"));
        assert!(!ct_eq(b"token", b"token "));
        assert!(!ct_eq(b"", b"x"));
        assert!(ct_eq(b"", b""));
    }
}
