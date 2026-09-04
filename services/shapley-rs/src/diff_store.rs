//! Per-epoch diff shape store: memory, then durable persistence. Records are
//! written by `PUT /diff/shape/:epoch`, which the Next.js cron calls with the
//! shape it extracted from the snapshot it already downloaded. Reads never
//! touch the public snapshot bucket, so an epoch nobody wrote is a 404.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use aws_sdk_s3::error::DisplayErrorContext;

use crate::cache::S3CacheRef;
use crate::diff::DiffShape;
use crate::diff_error::DiffStoreError;
use crate::epoch::{BoxFuture, Epoch, MIN_DZ_EPOCH};

/// BUMP when `DiffShape` fields change, or when the extractor that fills them
/// changes what it emits. That extractor now lives in the Next.js cron
/// (`lib/utils/diff-shape.ts`), so the trigger for a bump is a change there,
/// not in this crate. Independent of `CACHE_VERSION_PREFIX`: an LP engine bump
/// must not orphan the diff index.
pub const DIFF_SHAPE_VERSION_PREFIX: &str = "diff/v1";
/// How long the highest known epoch is trusted before the shape prefix is
/// listed again. A successful `put` advances it without waiting for the TTL.
pub const LATEST_EPOCH_TTL: Duration = Duration::from_secs(5 * 60);

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

/// Durable per-epoch shape storage. The S3 implementation writes JSON to the
/// result-cache bucket; tests use a HashMap.
pub trait ShapePersistence: Send + Sync {
    /// The shape persisted for `epoch`. A malformed object is logged and
    /// treated as a miss.
    fn load(&self, epoch: Epoch) -> BoxFuture<'_, Option<Arc<DiffShape>>>;
    /// Persist one shape, overwriting whatever is at that key.
    ///
    /// Create-only is enforced one level up in [`DiffStore::put`], not here,
    /// because the repair case needs to overwrite deliberately.
    fn store<'a>(&'a self, shape: &'a DiffShape) -> BoxFuture<'a, Result<(), anyhow::Error>>;
    /// Whether an object exists at this epoch's key, whatever its contents.
    ///
    /// Distinct from `load`, which answers `None` for an absent object AND for
    /// one that is corrupt or names another epoch. `put` needs to tell those
    /// apart, and a transient store failure must surface as `Err` here rather
    /// than read as absent and let a write through.
    fn exists(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, anyhow::Error>>;
    /// Every epoch that has a persisted shape.
    fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>>;
    /// Whether a stored shape outlives the process. `true` for any real
    /// backing store; [`NoPersistence`] overrides it to `false`, which is what
    /// makes the write routes answer 503 instead of accepting a record that
    /// silently evaporates on restart.
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

    async fn head_object(&self, epoch: Epoch) -> Result<bool, anyhow::Error> {
        let key = shape_key(epoch);
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(error) if error.as_service_error().is_some_and(|e| e.is_not_found()) => Ok(false),
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
    fn load(&self, epoch: Epoch) -> BoxFuture<'_, Option<Arc<DiffShape>>> {
        Box::pin(self.load_object(epoch))
    }

    fn store<'a>(&'a self, shape: &'a DiffShape) -> BoxFuture<'a, Result<(), anyhow::Error>> {
        Box::pin(self.store_object(shape))
    }

    fn exists(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, anyhow::Error>> {
        Box::pin(self.head_object(epoch))
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

    fn exists(&self, _epoch: Epoch) -> BoxFuture<'_, Result<bool, anyhow::Error>> {
        Box::pin(async { Ok(false) })
    }

    fn persisted_epochs(&self) -> BoxFuture<'_, Result<BTreeSet<Epoch>, anyhow::Error>> {
        Box::pin(async { Ok(BTreeSet::new()) })
    }

    fn is_durable(&self) -> bool {
        false
    }
}

/// Two-tier shape store behind the `/diff*` handlers: process memory, then the
/// persisted record. Records arrive by `PUT /diff/shape/:epoch` from the
/// Next.js cron, which already downloads each epoch's snapshot for the Shapley
/// sweep. Nothing here reads the public snapshot bucket, so a miss is a miss.
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

    /// Memory, then persistence. Absent is [`DiffStoreError::NotFound`].
    ///
    /// There is no third tier. Before the extractor moved to the cron this fell
    /// through to an ingest, so any epoch in the bucket answered eventually;
    /// now an epoch nobody wrote is a 404 until the cron's repair pass fills it.
    pub async fn get(&self, epoch: Epoch) -> Result<Arc<DiffShape>, DiffStoreError> {
        if let Some(shape) = self.cached(epoch) {
            return Ok(shape);
        }
        match self.persistence.load(epoch).await {
            Some(shape) => {
                self.remember(epoch, Arc::clone(&shape));
                Ok(shape)
            }
            None => Err(DiffStoreError::NotFound { epoch }),
        }
    }

    /// Persist one epoch's shape. Create-only, with one repair case.
    ///
    /// Epochs are immutable, so a second write of a readable record is a
    /// [`DiffStoreError::Conflict`] rather than an overwrite. That is what
    /// stops a leaked ingest token from rewriting history.
    ///
    /// The repair case matters: [`ShapePersistence::load`] answers `None` both
    /// for an absent object and for one that is present but corrupt or that
    /// names another epoch. Refusing on presence alone would wedge such an
    /// epoch forever, so presence is probed with
    /// [`ShapePersistence::exists`] and the conflict is raised only when the
    /// stored object also loads. A present-but-unreadable object is replaced.
    ///
    /// Two writers racing the same absent epoch both observe absent and both
    /// write. That is harmless here: an epoch is immutable and both carry the
    /// same bytes, so the loser overwrites with an identical body.
    pub async fn put(&self, shape: DiffShape) -> Result<(), DiffStoreError> {
        let epoch = shape.epoch;
        let is_present = self
            .persistence
            .exists(epoch)
            .await
            .map_err(|error| DiffStoreError::persistence(epoch, error))?;
        if is_present {
            if self.persistence.load(epoch).await.is_some() {
                return Err(DiffStoreError::Conflict { epoch });
            }
            tracing::warn!(
                epoch = epoch.0,
                "persisted diff shape is unreadable; replacing it"
            );
        }
        self.persistence
            .store(&shape)
            .await
            .map_err(|error| DiffStoreError::persistence(epoch, error))?;
        self.remember(epoch, Arc::new(shape));
        self.advance_latest(epoch);
        Ok(())
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

    /// Epochs in `[latest - depth + 1, latest]`, clamped at [`MIN_DZ_EPOCH`],
    /// that have no record. Ascending. This is what the cron reads to decide
    /// which snapshots to download, so it always re-lists rather than trusting
    /// the TTL cache.
    pub async fn missing_epochs(
        &self,
        latest: Epoch,
        depth: u32,
    ) -> Result<Vec<Epoch>, DiffStoreError> {
        let known = self.known_epochs().await?;
        let first = latest
            .0
            .saturating_sub(depth.saturating_sub(1))
            .max(MIN_DZ_EPOCH.0);
        Ok((first..=latest.0)
            .map(Epoch)
            .filter(|epoch| !known.contains(epoch))
            .collect())
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
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, PoisonError};

    use super::{BTreeSet, DiffShape, ShapePersistence};
    use crate::epoch::{BoxFuture, Epoch};

    /// HashMap-backed persistence that counts loads and stores.
    #[derive(Default)]
    pub(crate) struct MemoryPersistence {
        shapes: Mutex<HashMap<Epoch, Arc<DiffShape>>>,
        /// Epochs whose object is present but does not load, standing in for a
        /// corrupt body or one naming another epoch.
        unreadable: Mutex<BTreeSet<Epoch>>,
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

        /// An object that `exists` sees and `load` cannot read.
        pub(crate) fn insert_unreadable(&self, epoch: Epoch) {
            self.unreadable
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(epoch);
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
                self.unreadable
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&shape.epoch);
                self.insert(shape.clone());
                Ok(())
            })
        }

        fn exists(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, anyhow::Error>> {
            let is_present = self
                .shapes
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains_key(&epoch)
                || self
                    .unreadable
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .contains(&epoch);
            Box::pin(async move { Ok(is_present) })
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
        assert_eq!(persistence.load_calls(), 0, "put seeded memory");
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
        // `load` answers None for a corrupt body, so refusing on presence alone
        // would wedge this epoch forever.
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
    async fn missing_epochs_counts_memory_so_a_dev_run_is_not_all_holes() {
        // NoPersistence lists nothing, so without the memory union every epoch
        // this process just wrote would be reported missing.
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
        assert!(!NoPersistence.exists(Epoch(204)).await.expect("probe works"));
    }
}
