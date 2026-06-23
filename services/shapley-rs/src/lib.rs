//! Library target — exposes modules for integration tests.
//! This is not a public API; types may change without notice.

pub mod cache;
pub mod jobs;
pub mod model;
pub mod queue;
pub mod routes;
pub mod worker;

use tokio::sync::RwLock;

/// Shared application state, accessible from route handlers via
/// `State<Arc<AppState>>`.
///
/// Phase 2 (ADR 0001) removed the in-process `compute_semaphore`: the heavy
/// what-if path now runs on the externalized worker pool (concurrency = worker
/// count, governed by the worker autoscaler), not in the API process. The remaining synchronous
/// compute endpoints (`/shapley`, `/simulate`, `/link-estimate`) run in-process
/// unbounded except by the axum request timeout + body-size limit; protecting
/// them is a separate follow-up if it ever matters.
pub struct AppState {
    /// In-memory epoch cache (populated on first Shapley compute, and
    /// rehydrated from S3 on a cache miss when an S3 cache is configured).
    pub epoch_cache: RwLock<Option<cache::EpochCache>>,
    /// S3 persistence layer. `None` when `S3_CACHE_BUCKET` is unset
    /// (local dev).
    pub s3_cache: Option<cache::S3Cache>,
    /// Bearer token required on compute endpoints. `None` disables auth
    /// (local dev) — production sets `SHAPLEY_API_TOKEN` via a Secret.
    pub api_token: Option<String>,
    /// Redis-backed async-job store + work queue (`/jobs/*` enqueue/poll/cancel
    /// in the API role; `XREADGROUP` consume in the worker role), shared across
    /// replicas. `None` when `REDIS_URL` is unset — `/jobs/*` then 503 and the
    /// worker refuses to start, while the synchronous endpoints keep working.
    pub jobs: Option<jobs::RedisJobStore>,
}
