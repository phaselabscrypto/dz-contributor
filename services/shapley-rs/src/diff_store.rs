//! Per-epoch diff shape store: memory, then durable persistence, then ingest
//! from the snapshot bucket. `get` runs one ingest per epoch at a time and
//! caches no failure. `ingest` and `fill_missing` go straight to the bucket.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use aws_sdk_s3::error::DisplayErrorContext;
use tokio::sync::{OnceCell, Semaphore};

use crate::cache::S3CacheRef;
use crate::diff::{DiffShape, extract_diff_shape, parse_sections};
use crate::snapshot::{
    BoxFuture, Epoch, MIN_DZ_EPOCH, ScanFailure, SnapshotError, SnapshotReader, discover_latest,
};

/// BUMP when `DiffShape` fields or `extract_diff_shape`'s emitted values
/// change, or `DIFF_SECTION_KEYS` changes. Independent of
/// `CACHE_VERSION_PREFIX`: an LP engine bump must not orphan the diff index.
pub const DIFF_SHAPE_VERSION_PREFIX: &str = "diff/v1";
/// How long a discovered latest epoch is trusted before probing the bucket again.
pub const LATEST_EPOCH_TTL: Duration = Duration::from_secs(5 * 60);
/// Snapshot ingests allowed at once in one process, across every request and
/// the poller. An ingest holds its captured section bytes through the parse,
/// so this is what bounds ingest memory and the blocking-pool queue.
pub const MAX_CONCURRENT_INGESTS: usize = 6;
/// Delay before a failed fill attempt is retried, doubled per consecutive
/// failure and capped at [`FILL_RETRY_MAX`].
pub const FILL_RETRY_BASE: Duration = Duration::from_secs(15 * 60);
/// Ceiling on the fill retry delay.
pub const FILL_RETRY_MAX: Duration = Duration::from_secs(24 * 60 * 60);

const SHAPE_KEY_STEM: &str = "shape-";
const SHAPE_KEY_SUFFIX: &str = ".json";
const SHAPE_CONTENT_TYPE: &str = "application/json";
const FILL_PROGRESS_EVERY: usize = 10;
const FILL_RETRY_MAX_SHIFT: u32 = 8;

/// Object key of one epoch's persisted shape: `diff/v1/shape-000211.json`.
pub(crate) fn shape_key(epoch: Epoch) -> String {
    format!(
        "{DIFF_SHAPE_VERSION_PREFIX}/{SHAPE_KEY_STEM}{:06}{SHAPE_KEY_SUFFIX}",
        epoch.0
    )
}

/// Common prefix of every persisted shape key.
pub(crate) fn shape_key_prefix() -> String {
    format!("{DIFF_SHAPE_VERSION_PREFIX}/{SHAPE_KEY_STEM}")
}

/// Inverse of [`shape_key`]; `None` for any key outside the shape layout.
pub(crate) fn epoch_from_key(key: &str) -> Option<Epoch> {
    let digits = key
        .strip_prefix(shape_key_prefix().as_str())?
        .strip_suffix(SHAPE_KEY_SUFFIX)?;
    digits.parse::<u32>().ok().map(Epoch)
}

/// Durable per-epoch shape storage. The S3 implementation writes JSON to the
/// result-cache bucket; tests use a HashMap.
pub trait ShapePersistence: Send + Sync {
    /// The shape persisted for `epoch`. A malformed object is logged and
    /// treated as a miss.
    fn load(&self, epoch: Epoch) -> BoxFuture<'_, Option<Arc<DiffShape>>>;
    /// Persist one shape. Idempotent: the same epoch always writes the same bytes.
    fn store<'a>(&'a self, shape: &'a DiffShape) -> BoxFuture<'a, Result<(), anyhow::Error>>;
    /// Every epoch that has a persisted shape.
    fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>>;
    /// Whether a stored shape outlives the process. `true` for any real
    /// backing store; [`NoPersistence`] overrides it to `false` so the poller
    /// does not re-ingest every epoch on each pass and the one-shot
    /// `diff-backfill` role can refuse to run at all.
    fn is_durable(&self) -> bool {
        true
    }
}

/// Shape persistence in the S3-compatible result-cache bucket.
pub struct S3ShapePersistence {
    client: aws_sdk_s3::Client,
    bucket: String,
}

impl From<S3CacheRef> for S3ShapePersistence {
    fn from(cache: S3CacheRef) -> Self {
        Self {
            client: cache.client,
            bucket: cache.bucket,
        }
    }
}

impl S3ShapePersistence {
    async fn load_object(&self, epoch: Epoch) -> Option<Arc<DiffShape>> {
        let key = shape_key(epoch);
        let response = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                if error
                    .as_service_error()
                    .is_some_and(|service_error| service_error.is_no_such_key())
                {
                    tracing::debug!(%key, "no persisted diff shape (miss)");
                } else {
                    tracing::warn!(error = %DisplayErrorContext(&error), %key,
                        "S3 get_object failed for diff shape");
                }
                return None;
            }
        };
        let bytes = match response.body.collect().await {
            Ok(aggregated) => aggregated.into_bytes(),
            Err(error) => {
                tracing::warn!(error = %error, %key, "failed to read persisted diff shape body");
                return None;
            }
        };
        match serde_json::from_slice::<DiffShape>(&bytes) {
            Ok(shape) if shape.epoch == epoch => Some(Arc::new(shape)),
            Ok(shape) => {
                tracing::warn!(%key, found = shape.epoch.0,
                    "persisted diff shape names another epoch; treating as miss");
                None
            }
            Err(error) => {
                tracing::warn!(error = %error, %key,
                    "persisted diff shape is malformed; treating as miss");
                None
            }
        }
    }

    async fn store_object(&self, shape: &DiffShape) -> Result<(), anyhow::Error> {
        let key = shape_key(shape.epoch);
        let bytes = serde_json::to_vec(shape)?;
        let size_bytes = bytes.len();
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .content_type(SHAPE_CONTENT_TYPE)
            .body(bytes.into())
            .send()
            .await
            .map_err(|error| anyhow::anyhow!("{}", DisplayErrorContext(&error)))?;
        tracing::info!(%key, size_bytes, "stored diff shape to S3");
        Ok(())
    }

    async fn list_epochs(&self) -> Result<BTreeSet<Epoch>, anyhow::Error> {
        let prefix = shape_key_prefix();
        let mut epochs = BTreeSet::new();
        let mut continuation_token: Option<String> = None;
        loop {
            let page = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&prefix)
                .set_continuation_token(continuation_token.take())
                .send()
                .await
                .map_err(|error| anyhow::anyhow!("{}", DisplayErrorContext(&error)))?;
            epochs.extend(
                page.contents()
                    .iter()
                    .filter_map(|object| object.key())
                    .filter_map(epoch_from_key),
            );
            if page.is_truncated() != Some(true) {
                break;
            }
            match page.next_continuation_token() {
                Some(token) => continuation_token = Some(token.to_string()),
                None => break,
            }
        }
        Ok(epochs)
    }
}

impl ShapePersistence for S3ShapePersistence {
    fn load(&self, epoch: Epoch) -> BoxFuture<'_, Option<Arc<DiffShape>>> {
        Box::pin(self.load_object(epoch))
    }

    fn store<'a>(&'a self, shape: &'a DiffShape) -> BoxFuture<'a, Result<(), anyhow::Error>> {
        Box::pin(self.store_object(shape))
    }

    fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>> {
        Box::pin(self.list_epochs())
    }
}

/// Persistence for a deployment without `S3_CACHE_BUCKET`: every load misses,
/// every store succeeds, nothing is ever listed.
pub struct NoPersistence;

impl ShapePersistence for NoPersistence {
    fn load(&self, _epoch: Epoch) -> BoxFuture<'_, Option<Arc<DiffShape>>> {
        Box::pin(async { None })
    }

    fn store<'a>(&'a self, _shape: &'a DiffShape) -> BoxFuture<'a, Result<(), anyhow::Error>> {
        Box::pin(async { Ok(()) })
    }

    fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>> {
        Box::pin(async { Ok(BTreeSet::new()) })
    }

    fn is_durable(&self) -> bool {
        false
    }
}

/// Result of one epoch in [`DiffStore::fill_missing`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IngestOutcome {
    /// The snapshot was scanned and the shape stored.
    Ingested {
        /// Snapshot bytes read from the bucket.
        bytes_read: usize,
        /// Wall time of the ingest in milliseconds.
        ms: u128,
    },
    /// A shape for this epoch was already persisted.
    AlreadyPersisted,
    /// The bucket has no snapshot for this epoch.
    Missing,
    /// The ingest failed; the text is the error's `Display`.
    Failed(String),
    /// An earlier attempt failed and its backoff has not elapsed.
    Deferred,
}

struct IngestReport {
    shape: Arc<DiffShape>,
    bytes_read: usize,
    elapsed: Duration,
    /// `Some` when the shape was extracted but the write did not land.
    persist_error: Option<String>,
}

/// Whether a fill pass honours the per-epoch retry backoff.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FillPolicy {
    /// Attempt every missing epoch. The one-shot `diff-backfill` role, where
    /// an operator asked for a complete fill now.
    EveryEpoch,
    /// Skip an epoch whose backoff has not elapsed. The poller.
    DueOnly,
}

/// Fill backoff for one epoch.
struct RetryState {
    failures: u32,
    next_attempt: Instant,
}

type ShapeCell = Arc<OnceCell<Arc<DiffShape>>>;

/// Three-tier shape store shared by the `/diff*` handlers and the poller.
pub struct DiffStore {
    reader: Arc<dyn SnapshotReader>,
    persistence: Arc<dyn ShapePersistence>,
    shapes: RwLock<HashMap<Epoch, Arc<DiffShape>>>,
    in_flight: Mutex<HashMap<Epoch, ShapeCell>>,
    latest: Mutex<Option<(Epoch, Instant)>>,
    retry_after: Mutex<HashMap<Epoch, RetryState>>,
    ingest_permits: Semaphore,
}

impl DiffStore {
    /// A store with empty memory over the given reader and persistence.
    pub fn new(reader: Arc<dyn SnapshotReader>, persistence: Arc<dyn ShapePersistence>) -> Self {
        Self {
            reader,
            persistence,
            shapes: RwLock::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
            latest: Mutex::new(None),
            retry_after: Mutex::new(HashMap::new()),
            ingest_permits: Semaphore::new(MAX_CONCURRENT_INGESTS),
        }
    }

    /// Memory, then persistence, then ingest. Concurrent callers for one cold
    /// epoch share a single ingest. Never caches a failure.
    pub async fn get(&self, epoch: Epoch) -> Result<Arc<DiffShape>, SnapshotError> {
        if let Some(shape) = self.cached(epoch) {
            return Ok(shape);
        }
        let flight = InFlightGuard {
            store: self,
            epoch,
            cell: self.in_flight_cell(epoch),
        };
        let result = flight
            .cell
            .get_or_try_init(|| async {
                match self.persistence.load(epoch).await {
                    Some(shape) => Ok(shape),
                    None => self.ingest(epoch).await,
                }
            })
            .await
            .map(Arc::clone);
        if let Ok(shape) = &result {
            self.remember(epoch, Arc::clone(shape));
        }
        result
    }

    /// Fetch, parse and extract off the executor, store to memory, then
    /// persist. A persistence failure is logged and not returned.
    pub async fn ingest(&self, epoch: Epoch) -> Result<Arc<DiffShape>, SnapshotError> {
        self.ingest_with_report(epoch)
            .await
            .map(|report| report.shape)
    }

    /// Highest published epoch, re-discovered at most every [`LATEST_EPOCH_TTL`].
    pub async fn latest_epoch(&self) -> Result<Epoch, SnapshotError> {
        if let Some(latest) = self.fresh_latest() {
            return Ok(latest);
        }
        let latest = discover_latest(self.reader.as_ref()).await?;
        *self.latest.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((latest, Instant::now()));
        Ok(latest)
    }

    /// Whether this store's persistence outlives the process.
    pub fn has_durable_persistence(&self) -> bool {
        self.persistence.is_durable()
    }

    /// Ingest every epoch in `MIN_DZ_EPOCH..=latest` absent from the
    /// persisted set, in ascending order, and report each epoch's outcome.
    /// When the persisted set cannot be listed, or persistence is not durable,
    /// the epochs already held in memory stand in for it and are reported as
    /// `AlreadyPersisted`. Under [`FillPolicy::DueOnly`] an epoch whose retry
    /// backoff has not elapsed is reported as `Deferred` and not read.
    pub async fn fill_missing(
        &self,
        latest: Epoch,
        policy: FillPolicy,
    ) -> Vec<(Epoch, IngestOutcome)> {
        let persisted = if self.persistence.is_durable() {
            match self.persistence.persisted_epochs().await {
                Ok(persisted) => persisted,
                Err(error) => {
                    tracing::error!(error = %error,
                        "diff index: failed to list persisted shapes; skipping epochs held in \
                         memory");
                    self.memory_epochs()
                }
            }
        } else {
            self.memory_epochs()
        };
        let mut outcomes = Vec::new();
        let mut processed = 0usize;
        for number in MIN_DZ_EPOCH.0..=latest.0 {
            let epoch = Epoch(number);
            if persisted.contains(&epoch) {
                self.clear_retry(epoch);
                outcomes.push((epoch, IngestOutcome::AlreadyPersisted));
                continue;
            }
            if policy == FillPolicy::DueOnly && self.is_deferred(epoch) {
                outcomes.push((epoch, IngestOutcome::Deferred));
                continue;
            }
            let outcome = match self.ingest_with_report(epoch).await {
                Ok(report) => match report.persist_error {
                    None => {
                        self.clear_retry(epoch);
                        IngestOutcome::Ingested {
                            bytes_read: report.bytes_read,
                            ms: report.elapsed.as_millis(),
                        }
                    }
                    Some(error) => {
                        self.defer_retry(epoch);
                        IngestOutcome::Failed(format!("shape not persisted: {error}"))
                    }
                },
                Err(SnapshotError::NotFound { .. }) => {
                    self.defer_retry(epoch);
                    IngestOutcome::Missing
                }
                Err(error) => {
                    tracing::warn!(epoch = epoch.0, error = %error, "diff index: ingest failed");
                    self.defer_retry(epoch);
                    IngestOutcome::Failed(error.to_string())
                }
            };
            outcomes.push((epoch, outcome));
            processed += 1;
            if processed.is_multiple_of(FILL_PROGRESS_EVERY) {
                log_fill_progress(&outcomes, processed, latest);
            }
        }
        outcomes
    }

    async fn ingest_with_report(&self, epoch: Epoch) -> Result<IngestReport, SnapshotError> {
        let started = Instant::now();
        // Held across the fetch and the parse, so it bounds both at once.
        let _permit = self.ingest_permits.acquire().await.ok();
        let scan = self.reader.fetch_sections(epoch).await?;
        let bytes_read = scan.bytes_read;
        let shape = tokio::task::spawn_blocking(move || {
            parse_sections(&scan).map(|sections| extract_diff_shape(epoch, &sections))
        })
        .await
        .map_err(|join_error| SnapshotError::Scan {
            epoch,
            bytes_read,
            failure: ScanFailure::Malformed(format!("shape extraction task failed: {join_error}")),
        })??;
        let shape = Arc::new(shape);
        self.remember(epoch, Arc::clone(&shape));
        let elapsed = started.elapsed();
        tracing::info!(
            epoch = epoch.0,
            bytes_read,
            ms = elapsed.as_millis(),
            links = shape.links.len(),
            contributors = shape.contributors.len(),
            "diff index: ingested epoch"
        );
        let persist_error = match self.persistence.store(&shape).await {
            Ok(()) => None,
            Err(error) => {
                tracing::error!(epoch = epoch.0, error = %error,
                    "diff index: failed to persist shape");
                Some(error.to_string())
            }
        };
        Ok(IngestReport {
            shape,
            bytes_read,
            elapsed,
            persist_error,
        })
    }

    fn cached(&self, epoch: Epoch) -> Option<Arc<DiffShape>> {
        let shapes = self.shapes.read().unwrap_or_else(PoisonError::into_inner);
        shapes.get(&epoch).map(Arc::clone)
    }

    fn remember(&self, epoch: Epoch, shape: Arc<DiffShape>) {
        let mut shapes = self.shapes.write().unwrap_or_else(PoisonError::into_inner);
        shapes.insert(epoch, shape);
    }

    fn memory_epochs(&self) -> BTreeSet<Epoch> {
        let shapes = self.shapes.read().unwrap_or_else(PoisonError::into_inner);
        shapes.keys().copied().collect()
    }

    fn in_flight_cell(&self, epoch: Epoch) -> ShapeCell {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        Arc::clone(in_flight.entry(epoch).or_default())
    }

    fn release_in_flight(&self, epoch: Epoch, cell: &ShapeCell) {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if in_flight
            .get(&epoch)
            .is_some_and(|current| Arc::ptr_eq(current, cell))
        {
            in_flight.remove(&epoch);
        }
    }

    fn fresh_latest(&self) -> Option<Epoch> {
        let latest = self.latest.lock().unwrap_or_else(PoisonError::into_inner);
        latest
            .filter(|(_, discovered_at)| discovered_at.elapsed() < LATEST_EPOCH_TTL)
            .map(|(epoch, _)| epoch)
    }

    fn is_deferred(&self, epoch: Epoch) -> bool {
        self.retry_after
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&epoch)
            .is_some_and(|state| Instant::now() < state.next_attempt)
    }

    fn defer_retry(&self, epoch: Epoch) {
        let mut retries = self
            .retry_after
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let state = retries.entry(epoch).or_insert(RetryState {
            failures: 0,
            next_attempt: Instant::now(),
        });
        state.failures = state.failures.saturating_add(1);
        let delay = FILL_RETRY_BASE
            .saturating_mul(1u32 << state.failures.min(FILL_RETRY_MAX_SHIFT))
            .min(FILL_RETRY_MAX);
        state.next_attempt = Instant::now() + delay;
    }

    fn clear_retry(&self, epoch: Epoch) {
        self.retry_after
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&epoch);
    }

    #[cfg(test)]
    fn in_flight_len(&self) -> usize {
        self.in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

/// Drops the epoch's in-flight cell when a read finishes, including when the
/// caller is cancelled mid-await.
struct InFlightGuard<'a> {
    store: &'a DiffStore,
    epoch: Epoch,
    cell: ShapeCell,
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.store.release_in_flight(self.epoch, &self.cell);
    }
}

fn log_fill_progress(outcomes: &[(Epoch, IngestOutcome)], processed: usize, latest: Epoch) {
    let mut ingested = 0usize;
    let mut missing = 0usize;
    let mut failed = 0usize;
    let mut deferred = 0usize;
    for (_, outcome) in outcomes {
        match outcome {
            IngestOutcome::Ingested { .. } => ingested += 1,
            IngestOutcome::Missing => missing += 1,
            IngestOutcome::Failed(_) => failed += 1,
            IngestOutcome::Deferred => deferred += 1,
            IngestOutcome::AlreadyPersisted => {}
        }
    }
    tracing::info!(
        processed,
        ingested,
        missing,
        failed,
        deferred,
        latest = latest.0,
        "diff index: fill progress"
    );
}

/// In-memory reader and persistence for the store and poller unit tests.
#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, PoisonError};

    use super::{BTreeSet, DiffShape, ShapePersistence};
    use crate::snapshot::{
        BoxFuture, Epoch, ScanResult, SectionScanner, SnapshotError, SnapshotReader,
    };

    const SNAPSHOT_TAIL: &str = r#""solana_epoch": 900, "fetch_data": {"dz_serviceability": {"locations": {"L1": {"code": "nyc"}}, "exchanges": {}, "devices": {"D1": {"location_pk": "L1", "contributor_pk": "C1"}}, "links": {"K1": {"side_a_pk": "D1", "side_z_pk": "D1", "link_type": "WAN", "bandwidth": 10000000000, "contributor_pk": "C1"}}, "users": {}, "contributors": {"C1": {"code": "alpha"}}, "access_passes": {}}, "dz_telemetry": {"device_latency_samples": [{"link_pk": "K1"}]}}, "metadata": {"links": 1}}"#;
    const CHUNK_SIZE: usize = 32;

    /// A minimal well-formed snapshot carrying `epoch`.
    pub(crate) fn tiny_snapshot(epoch: Epoch) -> Vec<u8> {
        format!("{{\"dz_epoch\": {}, {SNAPSHOT_TAIL}", epoch.0).into_bytes()
    }

    /// Reader over synthetic snapshot bytes that counts calls and can fail a
    /// given number of fetches with a transport error first.
    pub(crate) struct FakeReader {
        snapshots: HashMap<Epoch, Vec<u8>>,
        fetch_calls: AtomicUsize,
        head_calls: AtomicUsize,
        failures_remaining: AtomicUsize,
    }

    impl FakeReader {
        pub(crate) fn with_epochs(epochs: impl IntoIterator<Item = u32>) -> Self {
            Self {
                snapshots: epochs
                    .into_iter()
                    .map(Epoch)
                    .map(|epoch| (epoch, tiny_snapshot(epoch)))
                    .collect(),
                fetch_calls: AtomicUsize::new(0),
                head_calls: AtomicUsize::new(0),
                failures_remaining: AtomicUsize::new(0),
            }
        }

        pub(crate) fn fail_next_fetches(&self, count: usize) {
            self.failures_remaining.store(count, Ordering::SeqCst);
        }

        pub(crate) fn fetch_calls(&self) -> usize {
            self.fetch_calls.load(Ordering::SeqCst)
        }

        pub(crate) fn head_calls(&self) -> usize {
            self.head_calls.load(Ordering::SeqCst)
        }

        fn take_failure(&self) -> bool {
            self.failures_remaining
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
        }
    }

    impl SnapshotReader for FakeReader {
        fn fetch_sections(&self, epoch: Epoch) -> BoxFuture<'_, Result<ScanResult, SnapshotError>> {
            Box::pin(async move {
                tokio::task::yield_now().await;
                self.fetch_calls.fetch_add(1, Ordering::SeqCst);
                if self.take_failure() {
                    return Err(SnapshotError::Transport {
                        epoch,
                        message: "injected failure".to_string(),
                    });
                }
                let bytes = self
                    .snapshots
                    .get(&epoch)
                    .ok_or(SnapshotError::NotFound { epoch })?;
                let mut scanner = SectionScanner::new(epoch);
                let mut has_stream_ended = true;
                for chunk in bytes.chunks(CHUNK_SIZE) {
                    let is_complete =
                        scanner.push(chunk).map_err(|failure| SnapshotError::Scan {
                            epoch,
                            bytes_read: scanner.bytes_read(),
                            failure,
                        })?;
                    if is_complete {
                        has_stream_ended = false;
                        break;
                    }
                }
                let bytes_read = scanner.bytes_read();
                scanner
                    .finish(has_stream_ended)
                    .map_err(|failure| SnapshotError::Scan {
                        epoch,
                        bytes_read,
                        failure,
                    })
            })
        }

        fn has_snapshot(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, SnapshotError>> {
            Box::pin(async move {
                self.head_calls.fetch_add(1, Ordering::SeqCst);
                Ok(self.snapshots.contains_key(&epoch))
            })
        }
    }

    /// HashMap-backed persistence that counts loads and stores.
    #[derive(Default)]
    pub(crate) struct MemoryPersistence {
        shapes: Mutex<HashMap<Epoch, Arc<DiffShape>>>,
        load_calls: AtomicUsize,
        store_calls: AtomicUsize,
        is_store_failing: AtomicBool,
    }

    impl MemoryPersistence {
        pub(crate) fn with_shape(shape: DiffShape) -> Self {
            let persistence = Self::default();
            persistence.insert(shape);
            persistence
        }

        pub(crate) fn insert(&self, shape: DiffShape) {
            self.shapes
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(shape.epoch, Arc::new(shape));
        }

        pub(crate) fn contains(&self, epoch: Epoch) -> bool {
            self.shapes
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains_key(&epoch)
        }

        pub(crate) fn load_calls(&self) -> usize {
            self.load_calls.load(Ordering::SeqCst)
        }

        pub(crate) fn store_calls(&self) -> usize {
            self.store_calls.load(Ordering::SeqCst)
        }

        /// Every later `store` fails while every `load` and `persisted_epochs`
        /// keeps working, which is what read-only credentials look like.
        pub(crate) fn fail_stores(&self) {
            self.is_store_failing.store(true, Ordering::SeqCst);
        }
    }

    impl ShapePersistence for MemoryPersistence {
        fn load(&self, epoch: Epoch) -> BoxFuture<'_, Option<Arc<DiffShape>>> {
            Box::pin(async move {
                self.load_calls.fetch_add(1, Ordering::SeqCst);
                self.shapes
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(&epoch)
                    .map(Arc::clone)
            })
        }

        fn store<'a>(&'a self, shape: &'a DiffShape) -> BoxFuture<'a, Result<(), anyhow::Error>> {
            Box::pin(async move {
                self.store_calls.fetch_add(1, Ordering::SeqCst);
                if self.is_store_failing.load(Ordering::SeqCst) {
                    return Err(anyhow::anyhow!("injected store failure"));
                }
                self.insert(shape.clone());
                Ok(())
            })
        }

        fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>> {
            Box::pin(async move {
                Ok(self
                    .shapes
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .keys()
                    .copied()
                    .collect())
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{FakeReader, MemoryPersistence};
    use super::*;
    use crate::diff::{ContributorRef, LinkRef};

    fn stored_shape(epoch: Epoch) -> DiffShape {
        DiffShape {
            epoch,
            links: vec![LinkRef {
                pubkey: "K9".to_string(),
                contributor_code: "beta".to_string(),
                side_a_code: "lon".to_string(),
                side_z_code: "fra".to_string(),
                bandwidth_gbps: 100.0,
                link_type: "WAN".to_string(),
            }],
            contributors: vec![ContributorRef {
                code: "beta".to_string(),
                link_count: 1,
                device_count: 1,
                metro_count: 1,
            }],
        }
    }

    fn store_over(reader: Arc<FakeReader>, persistence: Arc<MemoryPersistence>) -> DiffStore {
        DiffStore::new(reader, persistence)
    }

    #[test]
    fn shape_key_is_zero_padded_under_the_version_prefix() {
        assert_eq!(shape_key(Epoch(211)), "diff/v1/shape-000211.json");
        assert!(shape_key(Epoch(48)).starts_with(&shape_key_prefix()));
        assert!(shape_key_prefix().starts_with(DIFF_SHAPE_VERSION_PREFIX));
    }

    #[test]
    fn epoch_from_key_inverts_shape_key_and_rejects_other_keys() {
        assert_eq!(epoch_from_key(&shape_key(Epoch(211))), Some(Epoch(211)));
        assert_eq!(
            epoch_from_key("diff/v1/shape-1234567.json"),
            Some(Epoch(1_234_567))
        );
        assert_eq!(epoch_from_key("diff/v1/shape-000211.bin"), None);
        assert_eq!(
            epoch_from_key("shapley/v3/cache-00000000deadbeef.bin"),
            None
        );
        assert_eq!(epoch_from_key("diff/v1/shape-abc.json"), None);
    }

    #[tokio::test]
    async fn no_persistence_misses_accepts_and_lists_nothing() {
        let persistence = NoPersistence;
        assert!(persistence.load(Epoch(48)).await.is_none());
        assert!(persistence.store(&stored_shape(Epoch(48))).await.is_ok());
        assert!(persistence.persisted_epochs().await.unwrap().is_empty());
        assert!(!persistence.is_durable());
        assert!(MemoryPersistence::default().is_durable());
    }

    #[tokio::test]
    async fn fill_missing_without_durable_persistence_skips_epochs_held_in_memory() {
        let reader = Arc::new(FakeReader::with_epochs([48, 49]));
        let shared_reader: Arc<dyn SnapshotReader> = reader.clone();
        let store = DiffStore::new(shared_reader, Arc::new(NoPersistence));
        assert!(!store.has_durable_persistence());

        let first = store.fill_missing(Epoch(49), FillPolicy::DueOnly).await;
        assert!(matches!(first[0].1, IngestOutcome::Ingested { .. }));
        assert!(matches!(first[1].1, IngestOutcome::Ingested { .. }));
        assert_eq!(reader.fetch_calls(), 2);

        let second = store.fill_missing(Epoch(49), FillPolicy::DueOnly).await;
        assert_eq!(second[0].1, IngestOutcome::AlreadyPersisted);
        assert_eq!(second[1].1, IngestOutcome::AlreadyPersisted);
        assert_eq!(reader.fetch_calls(), 2);
    }

    #[test]
    fn s3_persistence_takes_the_cache_client_and_bucket() {
        let config = aws_sdk_s3::Config::builder()
            .behavior_version_latest()
            .region(aws_sdk_s3::config::Region::new("us-east-1"))
            .build();
        let persistence = S3ShapePersistence::from(S3CacheRef {
            client: aws_sdk_s3::Client::from_conf(config),
            bucket: "results".to_string(),
        });
        assert_eq!(persistence.bucket, "results");
    }

    #[tokio::test]
    async fn memory_hit_does_not_touch_the_reader_or_persistence() {
        let reader = Arc::new(FakeReader::with_epochs([48]));
        let persistence = Arc::new(MemoryPersistence::default());
        let store = store_over(Arc::clone(&reader), Arc::clone(&persistence));

        let ingested = store.ingest(Epoch(48)).await.unwrap();
        assert_eq!(reader.fetch_calls(), 1);
        assert_eq!(ingested.epoch, Epoch(48));
        assert_eq!(ingested.links[0].contributor_code, "alpha");

        let hit = store.get(Epoch(48)).await.unwrap();
        assert!(Arc::ptr_eq(&hit, &ingested));
        assert_eq!(reader.fetch_calls(), 1);
        assert_eq!(persistence.load_calls(), 0);
    }

    #[tokio::test]
    async fn persistence_hit_does_not_touch_the_reader() {
        let reader = Arc::new(FakeReader::with_epochs([48]));
        let persistence = Arc::new(MemoryPersistence::with_shape(stored_shape(Epoch(48))));
        let store = store_over(Arc::clone(&reader), Arc::clone(&persistence));

        let shape = store.get(Epoch(48)).await.unwrap();
        assert_eq!(shape.links[0].pubkey, "K9");
        assert_eq!(reader.fetch_calls(), 0);
        assert_eq!(persistence.load_calls(), 1);

        let again = store.get(Epoch(48)).await.unwrap();
        assert!(Arc::ptr_eq(&again, &shape));
        assert_eq!(persistence.load_calls(), 1);
    }

    #[tokio::test]
    async fn miss_ingests_once_and_persists() {
        let reader = Arc::new(FakeReader::with_epochs([48]));
        let persistence = Arc::new(MemoryPersistence::default());
        let store = store_over(Arc::clone(&reader), Arc::clone(&persistence));

        let shape = store.get(Epoch(48)).await.unwrap();
        assert_eq!(shape.epoch, Epoch(48));
        assert_eq!(reader.fetch_calls(), 1);
        assert_eq!(persistence.store_calls(), 1);
        assert!(persistence.contains(Epoch(48)));
        assert_eq!(store.in_flight_len(), 0);
    }

    #[tokio::test]
    async fn concurrent_gets_for_one_cold_epoch_share_one_ingest() {
        let reader = Arc::new(FakeReader::with_epochs([48]));
        let persistence = Arc::new(MemoryPersistence::default());
        let store = store_over(Arc::clone(&reader), Arc::clone(&persistence));

        let (first, second) = tokio::join!(store.get(Epoch(48)), store.get(Epoch(48)));
        let first = first.unwrap();
        let second = second.unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(reader.fetch_calls(), 1);
        assert_eq!(persistence.store_calls(), 1);
        assert_eq!(store.in_flight_len(), 0);
    }

    #[tokio::test]
    async fn reader_error_is_not_cached() {
        let reader = Arc::new(FakeReader::with_epochs([48]));
        let persistence = Arc::new(MemoryPersistence::default());
        let store = store_over(Arc::clone(&reader), Arc::clone(&persistence));

        reader.fail_next_fetches(1);
        let failure = store.get(Epoch(48)).await.unwrap_err();
        assert!(matches!(failure, SnapshotError::Transport { .. }));
        assert_eq!(store.in_flight_len(), 0);
        assert!(store.cached(Epoch(48)).is_none());

        let shape = store.get(Epoch(48)).await.unwrap();
        assert_eq!(shape.epoch, Epoch(48));
        assert_eq!(reader.fetch_calls(), 2);
    }

    #[tokio::test]
    async fn ingest_of_an_absent_epoch_is_not_found_and_stores_nothing() {
        let reader = Arc::new(FakeReader::with_epochs([48]));
        let persistence = Arc::new(MemoryPersistence::default());
        let store = store_over(Arc::clone(&reader), Arc::clone(&persistence));

        let failure = store.ingest(Epoch(49)).await.unwrap_err();
        assert!(matches!(
            failure,
            SnapshotError::NotFound { epoch: Epoch(49) }
        ));
        assert_eq!(persistence.store_calls(), 0);
        assert!(store.cached(Epoch(49)).is_none());
    }

    #[tokio::test]
    async fn fill_missing_reports_a_shape_that_was_not_written_as_failed() {
        let reader = Arc::new(FakeReader::with_epochs([48]));
        let persistence = Arc::new(MemoryPersistence::default());
        persistence.fail_stores();
        let store = DiffStore::new(
            Arc::clone(&reader) as Arc<dyn SnapshotReader>,
            Arc::clone(&persistence) as Arc<dyn ShapePersistence>,
        );

        let outcomes = store.fill_missing(Epoch(48), FillPolicy::EveryEpoch).await;

        assert!(
            matches!(outcomes[0].1, IngestOutcome::Failed(ref text)
                if text.contains("shape not persisted")),
            "got {:?}",
            outcomes[0].1
        );
        assert!(!persistence.contains(Epoch(48)));
    }

    #[tokio::test]
    async fn fill_missing_defers_a_failed_epoch_on_the_next_pass() {
        let reader = Arc::new(FakeReader::with_epochs([48]));
        let store = DiffStore::new(
            Arc::clone(&reader) as Arc<dyn SnapshotReader>,
            Arc::new(MemoryPersistence::default()),
        );
        reader.fail_next_fetches(1);

        let first = store.fill_missing(Epoch(48), FillPolicy::DueOnly).await;
        assert!(matches!(first[0].1, IngestOutcome::Failed(_)));
        assert_eq!(reader.fetch_calls(), 1);

        let second = store.fill_missing(Epoch(48), FillPolicy::DueOnly).await;
        assert_eq!(second[0].1, IngestOutcome::Deferred);
        assert_eq!(
            reader.fetch_calls(),
            1,
            "the backoff must suppress the retry"
        );

        let forced = store.fill_missing(Epoch(48), FillPolicy::EveryEpoch).await;
        assert!(matches!(forced[0].1, IngestOutcome::Ingested { .. }));
        assert_eq!(reader.fetch_calls(), 2, "the one-shot role ignores backoff");

        let after_success = store.fill_missing(Epoch(48), FillPolicy::DueOnly).await;
        assert_eq!(after_success[0].1, IngestOutcome::AlreadyPersisted);
    }

    #[tokio::test]
    async fn fill_missing_skips_persisted_epochs_and_reports_missing_ones() {
        let reader = Arc::new(FakeReader::with_epochs([48, 49, 51]));
        let persistence = Arc::new(MemoryPersistence::with_shape(stored_shape(Epoch(48))));
        let store = store_over(Arc::clone(&reader), Arc::clone(&persistence));
        reader.fail_next_fetches(1);
        assert!(store.has_durable_persistence());

        let outcomes = store.fill_missing(Epoch(51), FillPolicy::EveryEpoch).await;
        let epochs: Vec<Epoch> = outcomes.iter().map(|(epoch, _)| *epoch).collect();
        assert_eq!(epochs, vec![Epoch(48), Epoch(49), Epoch(50), Epoch(51)]);
        assert_eq!(outcomes[0].1, IngestOutcome::AlreadyPersisted);
        assert!(
            matches!(outcomes[1].1, IngestOutcome::Failed(ref text) if text.contains("injected"))
        );
        assert_eq!(outcomes[2].1, IngestOutcome::Missing);
        assert!(
            matches!(outcomes[3].1, IngestOutcome::Ingested { bytes_read, .. } if bytes_read > 0)
        );
        assert_eq!(reader.fetch_calls(), 3);
        assert!(persistence.contains(Epoch(51)));
        assert!(!persistence.contains(Epoch(50)));
    }

    #[tokio::test]
    async fn latest_epoch_is_discovered_once_within_the_ttl() {
        let reader = Arc::new(FakeReader::with_epochs(48..=60));
        let store = store_over(Arc::clone(&reader), Arc::new(MemoryPersistence::default()));

        assert_eq!(store.latest_epoch().await.unwrap(), Epoch(60));
        let probes = reader.head_calls();
        assert!(probes > 0);
        assert_eq!(store.latest_epoch().await.unwrap(), Epoch(60));
        assert_eq!(reader.head_calls(), probes);
    }
}
