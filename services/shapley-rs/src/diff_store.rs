//! Durable per-epoch shapes with a process cache. Missing records are repaired by ingestion.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use aws_sdk_s3::error::DisplayErrorContext;

use crate::cache::S3CacheRef;
use crate::diff::DiffShape;
use crate::diff_error::DiffStoreError;
use crate::epoch::{BoxFuture, Epoch, MIN_DZ_EPOCH};

/// Change when the persisted shape schema or extraction contract changes.
pub const DIFF_SHAPE_VERSION_PREFIX: &str = "diff/v1";
pub const LATEST_EPOCH_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_SHAPE_BYTES: usize = 2 * 1024 * 1024;
const MISSING_READ_CONCURRENCY: usize = 8;
const MISSING_READ_TIMEOUT: Duration = Duration::from_secs(2);
const MISSING_QUERY_TIMEOUT: Duration = Duration::from_secs(10);

const SHAPE_KEY_STEM: &str = "shape-";
const SHAPE_KEY_SUFFIX: &str = ".json";
const SHAPE_CONTENT_TYPE: &str = "application/json";

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

/// What a durable read found at an epoch's key.
#[derive(Debug)]
pub enum ShapeRead {
    /// No object at the key.
    Missing,
    Present(Arc<DiffShape>),
    /// Bytes exist but do not parse as this epoch's shape. Without an ETag the
    /// object cannot be replaced conditionally, so repair refuses it.
    Corrupt {
        etag: Option<String>,
    },
}

/// Precondition for a write: create only, or replace exactly the bytes a
/// corrupt read returned.
#[derive(Debug)]
pub enum ShapeWriteCondition {
    Absent,
    MatchEtag(String),
}

/// `PreconditionFailed` means another writer won; the caller decides whether
/// that winner is readable before calling it a conflict.
#[derive(Debug, PartialEq, Eq)]
pub enum ConditionalWriteOutcome {
    Stored,
    PreconditionFailed,
}

/// Read failures must remain errors; only downloaded bytes can prove corruption.
pub trait ShapePersistence: Send + Sync {
    fn load(&self, epoch: Epoch) -> BoxFuture<'_, Result<ShapeRead, anyhow::Error>>;
    fn store_conditional<'a>(
        &'a self,
        shape: &'a DiffShape,
        condition: ShapeWriteCondition,
    ) -> BoxFuture<'a, Result<ConditionalWriteOutcome, anyhow::Error>>;
    fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>>;
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
    async fn load_object(&self, epoch: Epoch) -> Result<ShapeRead, anyhow::Error> {
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
            Err(error) if error.as_service_error().is_some_and(|e| e.is_no_such_key()) => {
                return Ok(ShapeRead::Missing);
            }
            Err(error) => return Err(anyhow::anyhow!("{}", DisplayErrorContext(&error))),
        };
        let etag = response.e_tag().map(str::to_owned);
        anyhow::ensure!(
            response
                .content_length()
                .is_none_or(|size| size <= MAX_SHAPE_BYTES as i64),
            "persisted diff shape exceeds body limit"
        );
        let mut body = response.body;
        let mut bytes = Vec::new();
        while let Some(chunk) = body.next().await {
            let chunk = chunk?;
            anyhow::ensure!(
                chunk.len() <= MAX_SHAPE_BYTES.saturating_sub(bytes.len()),
                "persisted diff shape exceeds body limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        match serde_json::from_slice::<DiffShape>(&bytes) {
            Ok(shape) if shape.epoch == epoch => Ok(ShapeRead::Present(Arc::new(shape))),
            _ => {
                tracing::warn!(%key, "persisted diff shape is corrupt");
                Ok(ShapeRead::Corrupt { etag })
            }
        }
    }

    async fn store_object(
        &self,
        shape: &DiffShape,
        condition: ShapeWriteCondition,
    ) -> Result<ConditionalWriteOutcome, anyhow::Error> {
        let key = shape_key(shape.epoch);
        let bytes = serde_json::to_vec(shape)?;
        anyhow::ensure!(
            bytes.len() <= MAX_SHAPE_BYTES,
            "diff shape exceeds body limit"
        );
        let request = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .content_type(SHAPE_CONTENT_TYPE)
            .body(bytes.into());
        let request = match condition {
            ShapeWriteCondition::Absent => request.if_none_match("*"),
            ShapeWriteCondition::MatchEtag(etag) => request.if_match(etag),
        };
        match request.send().await {
            Ok(_) => Ok(ConditionalWriteOutcome::Stored),
            Err(error)
                if error
                    .raw_response()
                    .is_some_and(|r| r.status().as_u16() == 412) =>
            {
                Ok(ConditionalWriteOutcome::PreconditionFailed)
            }
            Err(error) => Err(anyhow::anyhow!("{}", DisplayErrorContext(&error))),
        }
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
    fn load(&self, epoch: Epoch) -> BoxFuture<'_, Result<ShapeRead, anyhow::Error>> {
        Box::pin(self.load_object(epoch))
    }
    fn store_conditional<'a>(
        &'a self,
        shape: &'a DiffShape,
        condition: ShapeWriteCondition,
    ) -> BoxFuture<'a, Result<ConditionalWriteOutcome, anyhow::Error>> {
        Box::pin(self.store_object(shape, condition))
    }
    fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>> {
        Box::pin(self.list_epochs())
    }
}

pub struct NoPersistence;

impl ShapePersistence for NoPersistence {
    fn load(&self, _epoch: Epoch) -> BoxFuture<'_, Result<ShapeRead, anyhow::Error>> {
        Box::pin(async { Ok(ShapeRead::Missing) })
    }
    fn store_conditional<'a>(
        &'a self,
        _shape: &'a DiffShape,
        _condition: ShapeWriteCondition,
    ) -> BoxFuture<'a, Result<ConditionalWriteOutcome, anyhow::Error>> {
        Box::pin(async { anyhow::bail!("durable shape persistence is disabled") })
    }
    fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>> {
        Box::pin(async { Ok(BTreeSet::new()) })
    }
    fn is_durable(&self) -> bool {
        false
    }
}

/// Reads use memory; write guards and repair discovery inspect persistence.
pub struct DiffStore {
    persistence: Arc<dyn ShapePersistence>,
    shapes: RwLock<HashMap<Epoch, Arc<DiffShape>>>,
    latest: Mutex<Option<(Epoch, Instant)>>,
}

impl DiffStore {
    /// A store with empty memory over the given persistence.
    pub fn new(persistence: Arc<dyn ShapePersistence>) -> Self {
        Self {
            persistence,
            shapes: RwLock::new(HashMap::new()),
            latest: Mutex::new(None),
        }
    }

    pub async fn get(&self, epoch: Epoch) -> Result<Arc<DiffShape>, DiffStoreError> {
        if let Some(shape) = self.cached(epoch) {
            return Ok(shape);
        }
        match self
            .persistence
            .load(epoch)
            .await
            .map_err(|e| DiffStoreError::persistence(epoch, e))?
        {
            ShapeRead::Present(shape) => {
                self.remember(epoch, Arc::clone(&shape));
                Ok(shape)
            }
            ShapeRead::Missing | ShapeRead::Corrupt { .. } => {
                Err(DiffStoreError::NotFound { epoch })
            }
        }
    }

    /// Creates an absent record or conditionally replaces proven-corrupt bytes.
    pub async fn put(&self, shape: DiffShape) -> Result<(), DiffStoreError> {
        let epoch = shape.epoch;
        let condition = match self
            .persistence
            .load(epoch)
            .await
            .map_err(|e| DiffStoreError::persistence(epoch, e))?
        {
            ShapeRead::Present(_) => return Err(DiffStoreError::Conflict { epoch }),
            ShapeRead::Missing => ShapeWriteCondition::Absent,
            ShapeRead::Corrupt { etag: Some(etag) } => ShapeWriteCondition::MatchEtag(etag),
            ShapeRead::Corrupt { etag: None } => {
                return Err(DiffStoreError::persistence(
                    epoch,
                    "corrupt record has no ETag",
                ));
            }
        };
        match self
            .persistence
            .store_conditional(&shape, condition)
            .await
            .map_err(|e| DiffStoreError::persistence(epoch, e))?
        {
            ConditionalWriteOutcome::Stored => {
                self.remember(epoch, Arc::new(shape));
                self.advance_latest(epoch);
                Ok(())
            }
            ConditionalWriteOutcome::PreconditionFailed => {
                match self
                    .persistence
                    .load(epoch)
                    .await
                    .map_err(|e| DiffStoreError::persistence(epoch, e))?
                {
                    ShapeRead::Present(_) => Err(DiffStoreError::Conflict { epoch }),
                    _ => Err(DiffStoreError::persistence(
                        epoch,
                        "conditional write lost without a readable winner",
                    )),
                }
            }
        }
    }

    /// Highest epoch with a record, re-listed at most every
    /// [`LATEST_EPOCH_TTL`]. A successful [`DiffStore::put`] advances it
    /// immediately, so a fresh write is never hidden behind the TTL.
    pub async fn latest_epoch(&self) -> Result<Epoch, DiffStoreError> {
        if let Some(latest) = self.fresh_latest() {
            return Ok(latest);
        }
        let known = self.known_epochs().await?;
        let latest = known
            .iter()
            .next_back()
            .copied()
            .ok_or(DiffStoreError::NotFound {
                epoch: MIN_DZ_EPOCH,
            })?;
        *self.latest.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((latest, Instant::now()));
        Ok(latest)
    }

    /// Returns absent or corrupt epochs in ascending order; unknown storage state fails the query.
    pub async fn missing_epochs(
        &self,
        latest: Epoch,
        depth: u32,
    ) -> Result<Vec<Epoch>, DiffStoreError> {
        let first = latest
            .0
            .saturating_sub(depth.saturating_sub(1))
            .max(MIN_DZ_EPOCH.0);
        tokio::time::timeout(MISSING_QUERY_TIMEOUT, async {
            let mut pending = tokio::task::JoinSet::new();
            let mut epochs = (first..=latest.0).map(Epoch);
            let mut missing = Vec::new();
            loop {
                while pending.len() < MISSING_READ_CONCURRENCY {
                    let Some(epoch) = epochs.next() else {
                        break;
                    };
                    let persistence = Arc::clone(&self.persistence);
                    pending.spawn(async move {
                        let read =
                            tokio::time::timeout(MISSING_READ_TIMEOUT, persistence.load(epoch))
                                .await
                                .map_err(|e| DiffStoreError::persistence(epoch, e))?
                                .map_err(|e| DiffStoreError::persistence(epoch, e))?;
                        Ok::<_, DiffStoreError>((epoch, read))
                    });
                }
                let Some(result) = pending.join_next().await else {
                    break;
                };
                let (epoch, read) =
                    result.map_err(|e| DiffStoreError::persistence(latest, e))??;
                if matches!(read, ShapeRead::Missing | ShapeRead::Corrupt { .. }) {
                    missing.push(epoch);
                }
            }
            missing.sort_unstable();
            Ok(missing)
        })
        .await
        .map_err(|e| DiffStoreError::persistence(latest, e))?
    }

    /// Whether this store's persistence outlives the process. `false` means a
    /// write is accepted and then lost, so the write routes refuse.
    pub fn has_durable_persistence(&self) -> bool {
        self.persistence.is_durable()
    }

    /// Every epoch this store can answer for. Memory counts, so a deployment
    /// without durable persistence still reports what it holds.
    async fn known_epochs(&self) -> Result<BTreeSet<Epoch>, DiffStoreError> {
        let mut known = self
            .persistence
            .persisted_epochs()
            .await
            .map_err(|error| DiffStoreError::persistence(MIN_DZ_EPOCH, error))?;
        known.extend(self.memory_epochs());
        Ok(known)
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

    fn fresh_latest(&self) -> Option<Epoch> {
        let latest = self.latest.lock().unwrap_or_else(PoisonError::into_inner);
        latest
            .filter(|(_, at)| at.elapsed() < LATEST_EPOCH_TTL)
            .map(|(epoch, _)| epoch)
    }

    /// Raise the cached latest to `epoch` after a write, leaving the TTL clock
    /// alone when the write was for an older epoch (a backfill).
    fn advance_latest(&self, epoch: Epoch) {
        let mut latest = self.latest.lock().unwrap_or_else(PoisonError::into_inner);
        match *latest {
            Some((known, _)) if known >= epoch => {}
            _ => *latest = Some((epoch, Instant::now())),
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct Records {
        shapes: HashMap<Epoch, (Option<Arc<DiffShape>>, String)>,
        version: usize,
    }
    #[derive(Default)]
    pub(crate) struct MemoryPersistence {
        records: Mutex<Records>,
        load_calls: AtomicUsize,
        store_calls: AtomicUsize,
        is_store_failing: AtomicBool,
        is_load_failing: AtomicBool,
    }
    impl MemoryPersistence {
        pub(crate) fn with_shape(shape: DiffShape) -> Self {
            let persistence = Self::default();
            persistence.insert(shape);
            persistence
        }
        pub(crate) fn insert(&self, shape: DiffShape) {
            self.set_record(shape.epoch, Some(Arc::new(shape)));
        }
        fn set_record(&self, epoch: Epoch, shape: Option<Arc<DiffShape>>) {
            let mut records = self.records.lock().unwrap_or_else(PoisonError::into_inner);
            records.version += 1;
            let etag = records.version.to_string();
            records.shapes.insert(epoch, (shape, etag));
        }
        pub(crate) fn insert_unreadable(&self, epoch: Epoch) {
            self.set_record(epoch, None);
        }
        pub(crate) fn load_calls(&self) -> usize {
            self.load_calls.load(Ordering::SeqCst)
        }
        pub(crate) fn store_calls(&self) -> usize {
            self.store_calls.load(Ordering::SeqCst)
        }
        pub(crate) fn fail_stores(&self) {
            self.is_store_failing.store(true, Ordering::SeqCst);
        }
        pub(crate) fn fail_loads(&self) {
            self.is_load_failing.store(true, Ordering::SeqCst);
        }
    }
    impl ShapePersistence for MemoryPersistence {
        fn load(&self, epoch: Epoch) -> BoxFuture<'_, Result<ShapeRead, anyhow::Error>> {
            Box::pin(async move {
                self.load_calls.fetch_add(1, Ordering::SeqCst);
                anyhow::ensure!(
                    !self.is_load_failing.load(Ordering::SeqCst),
                    "injected GET failure"
                );
                let records = self.records.lock().unwrap_or_else(PoisonError::into_inner);
                Ok(match records.shapes.get(&epoch) {
                    Some((Some(shape), _)) => ShapeRead::Present(Arc::clone(shape)),
                    Some((None, etag)) => ShapeRead::Corrupt {
                        etag: Some(etag.clone()),
                    },
                    None => ShapeRead::Missing,
                })
            })
        }
        fn store_conditional<'a>(
            &'a self,
            shape: &'a DiffShape,
            condition: ShapeWriteCondition,
        ) -> BoxFuture<'a, Result<ConditionalWriteOutcome, anyhow::Error>> {
            Box::pin(async move {
                self.store_calls.fetch_add(1, Ordering::SeqCst);
                anyhow::ensure!(
                    !self.is_store_failing.load(Ordering::SeqCst),
                    "injected store failure"
                );
                let mut records = self.records.lock().unwrap_or_else(PoisonError::into_inner);
                let is_match = match condition {
                    ShapeWriteCondition::Absent => !records.shapes.contains_key(&shape.epoch),
                    ShapeWriteCondition::MatchEtag(etag) => records
                        .shapes
                        .get(&shape.epoch)
                        .is_some_and(|(_, current)| *current == etag),
                };
                if !is_match {
                    return Ok(ConditionalWriteOutcome::PreconditionFailed);
                }
                records.version += 1;
                let etag = records.version.to_string();
                records
                    .shapes
                    .insert(shape.epoch, (Some(Arc::new(shape.clone())), etag));
                Ok(ConditionalWriteOutcome::Stored)
            })
        }
        fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>> {
            Box::pin(async move {
                Ok(self
                    .records
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .shapes
                    .keys()
                    .copied()
                    .collect())
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::MemoryPersistence;
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

    fn store_over(persistence: Arc<MemoryPersistence>) -> DiffStore {
        DiffStore::new(persistence)
    }

    #[test]
    fn shape_key_is_zero_padded_under_the_version_prefix() {
        assert_eq!(shape_key(Epoch(211)), "diff/v1/shape-000211.json");
        assert!(shape_key(Epoch(48)).starts_with(&shape_key_prefix()));
        assert!(shape_key_prefix().starts_with(DIFF_SHAPE_VERSION_PREFIX));
    }

    #[test]
    fn epoch_from_key_is_the_inverse_of_shape_key() {
        assert_eq!(epoch_from_key(&shape_key(Epoch(204))), Some(Epoch(204)));
        assert_eq!(epoch_from_key("diff/v1/shape-000204.txt"), None);
        assert_eq!(epoch_from_key("other/shape-000204.json"), None);
        assert_eq!(epoch_from_key("diff/v1/shape-notanumber.json"), None);
    }

    #[tokio::test]
    async fn get_reads_persistence_once_then_serves_from_memory() {
        let persistence = Arc::new(MemoryPersistence::with_shape(stored_shape(Epoch(204))));
        let store = store_over(Arc::clone(&persistence));

        let first = store.get(Epoch(204)).await.expect("persisted shape loads");
        let second = store
            .get(Epoch(204))
            .await
            .expect("memory serves the second");

        assert_eq!(first.epoch, Epoch(204));
        assert!(Arc::ptr_eq(&first, &second), "same Arc, so no second read");
        assert_eq!(persistence.load_calls(), 1);
    }

    #[tokio::test]
    async fn get_of_an_unwritten_epoch_is_not_found_and_never_ingests() {
        let store = store_over(Arc::new(MemoryPersistence::default()));
        let error = store.get(Epoch(204)).await.expect_err("nothing persisted");
        assert!(matches!(error, DiffStoreError::NotFound { epoch } if epoch == Epoch(204)));
        // The frozen string the changelog renders.
        assert_eq!(error.to_string(), "epoch 204: snapshot HTTP 404");
    }

    #[tokio::test]
    async fn put_persists_and_serves_without_touching_persistence_again() {
        let persistence = Arc::new(MemoryPersistence::default());
        let store = store_over(Arc::clone(&persistence));

        store
            .put(stored_shape(Epoch(205)))
            .await
            .expect("first write lands");

        assert_eq!(persistence.store_calls(), 1);
        let shape = store.get(Epoch(205)).await.expect("readable after put");
        assert_eq!(shape.epoch, Epoch(205));
        assert_eq!(
            persistence.load_calls(),
            1,
            "only the write guard reads persistence"
        );
    }

    #[tokio::test]
    async fn put_of_an_existing_readable_epoch_conflicts_and_writes_nothing() {
        let persistence = Arc::new(MemoryPersistence::with_shape(stored_shape(Epoch(206))));
        let store = store_over(Arc::clone(&persistence));

        let error = store
            .put(stored_shape(Epoch(206)))
            .await
            .expect_err("epochs are immutable");

        assert!(matches!(error, DiffStoreError::Conflict { epoch } if epoch == Epoch(206)));
        assert_eq!(persistence.store_calls(), 0, "the conflict wrote nothing");
    }

    #[tokio::test]
    async fn put_repairs_an_object_that_exists_but_cannot_be_read() {
        let persistence = Arc::new(MemoryPersistence::default());
        persistence.insert_unreadable(Epoch(207));
        let store = store_over(Arc::clone(&persistence));

        store
            .put(stored_shape(Epoch(207)))
            .await
            .expect("an unreadable record is replaced, not refused");

        assert_eq!(persistence.store_calls(), 1);
        assert_eq!(
            store.get(Epoch(207)).await.expect("readable now").epoch,
            Epoch(207)
        );
    }

    #[tokio::test]
    async fn put_surfaces_a_store_failure_as_persistence_not_success() {
        let persistence = Arc::new(MemoryPersistence::default());
        persistence.fail_stores();
        let store = store_over(Arc::clone(&persistence));

        let error = store
            .put(stored_shape(Epoch(208)))
            .await
            .expect_err("store fails");

        assert!(matches!(error, DiffStoreError::Persistence { epoch, .. } if epoch == Epoch(208)));
        assert!(
            store.get(Epoch(208)).await.is_err(),
            "a failed write is not cached"
        );
    }

    #[tokio::test]
    async fn latest_epoch_is_the_highest_written_and_a_put_advances_it() {
        let persistence = Arc::new(MemoryPersistence::with_shape(stored_shape(Epoch(204))));
        let store = store_over(Arc::clone(&persistence));

        assert_eq!(store.latest_epoch().await.expect("one record"), Epoch(204));

        // Without the advance this would sit behind LATEST_EPOCH_TTL.
        store
            .put(stored_shape(Epoch(211)))
            .await
            .expect("write lands");
        assert_eq!(store.latest_epoch().await.expect("advanced"), Epoch(211));

        // A backfill of an older epoch must not drag latest backwards.
        store
            .put(stored_shape(Epoch(209)))
            .await
            .expect("backfill lands");
        assert_eq!(store.latest_epoch().await.expect("still 211"), Epoch(211));
    }

    #[tokio::test]
    async fn latest_epoch_of_an_empty_store_is_not_found() {
        let store = store_over(Arc::new(MemoryPersistence::default()));
        assert!(matches!(
            store.latest_epoch().await,
            Err(DiffStoreError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn missing_epochs_reports_the_holes_in_the_window_ascending() {
        let persistence = Arc::new(MemoryPersistence::default());
        for epoch in [204u32, 206, 209] {
            persistence.insert(stored_shape(Epoch(epoch)));
        }
        let store = store_over(persistence);

        let missing = store
            .missing_epochs(Epoch(209), 6)
            .await
            .expect("listing works");

        assert_eq!(missing, vec![Epoch(205), Epoch(207), Epoch(208)]);
    }

    #[tokio::test]
    async fn missing_epochs_clamps_the_window_at_min_dz_epoch() {
        let store = store_over(Arc::new(MemoryPersistence::default()));
        let missing = store
            .missing_epochs(Epoch(49), 30)
            .await
            .expect("listing works");
        assert_eq!(missing, vec![Epoch(48), Epoch(49)]);
    }

    #[tokio::test]
    async fn missing_epochs_reports_persisted_shapes() {
        let store = store_over(Arc::new(MemoryPersistence::default()));
        store
            .put(stored_shape(Epoch(211)))
            .await
            .expect("write lands");
        let missing = store
            .missing_epochs(Epoch(211), 2)
            .await
            .expect("listing works");
        assert_eq!(missing, vec![Epoch(210)]);
    }

    #[tokio::test]
    async fn no_persistence_is_not_durable_and_lists_nothing() {
        let store = DiffStore::new(Arc::new(NoPersistence));
        assert!(!store.has_durable_persistence());
        assert!(store.get(Epoch(204)).await.is_err());
        assert!(matches!(
            NoPersistence.load(Epoch(204)).await.expect("probe works"),
            ShapeRead::Missing
        ));
    }
    #[tokio::test]
    async fn failed_get_never_writes_or_reports_no_gaps() {
        let persistence = Arc::new(MemoryPersistence::with_shape(stored_shape(Epoch(211))));
        persistence.fail_loads();
        let store = store_over(Arc::clone(&persistence));
        assert!(matches!(
            store.put(stored_shape(Epoch(211))).await,
            Err(DiffStoreError::Persistence { .. })
        ));
        assert_eq!(persistence.store_calls(), 0);
        assert!(matches!(
            store.get(Epoch(211)).await,
            Err(DiffStoreError::Persistence { .. })
        ));
        assert!(store.missing_epochs(Epoch(211), 1).await.is_err());
    }
    #[tokio::test]
    async fn corrupt_durable_record_is_missing_even_with_hot_memory() {
        let persistence = Arc::new(MemoryPersistence::with_shape(stored_shape(Epoch(211))));
        let store = store_over(Arc::clone(&persistence));
        store.get(Epoch(211)).await.unwrap();
        persistence.insert_unreadable(Epoch(211));
        assert_eq!(
            store.missing_epochs(Epoch(211), 1).await.unwrap(),
            vec![Epoch(211)]
        );
    }
}
