//! Worker-role loop and one-shot backfill that keep the diff index filled.

use std::sync::Arc;
use std::time::Duration;

use tokio::time::MissedTickBehavior;

use crate::diff_store::{DiffStore, FillPolicy, IngestOutcome};
use crate::snapshot::Epoch;

/// Time between two discovery-and-fill passes in the worker.
pub const POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);

struct FillSummary {
    latest: Epoch,
    ingested: usize,
    already_persisted: usize,
    missing: usize,
    deferred: usize,
    failed: Vec<Epoch>,
}

/// Worker-role loop: every [`POLL_INTERVAL`], discover the latest epoch and
/// fill every missing one. Errors are logged per epoch and never end the
/// loop. Runs until the future is dropped by the worker's shutdown select.
pub async fn run(store: Arc<DiffStore>) {
    let mut ticks = tokio::time::interval(POLL_INTERVAL);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        if let Some(summary) = fill(&store, FillPolicy::DueOnly).await {
            log_summary("diff poller: fill complete", &summary);
        }
    }
}

/// Why a one-shot backfill could not report a complete, durable fill.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackfillError {
    /// No durable shape persistence is configured. A fill would read every
    /// snapshot into process memory and lose all of it at exit, so the role
    /// refuses to run instead of reporting a success it cannot deliver.
    NoDurablePersistence,
    /// The latest published epoch could not be discovered; nothing was ingested.
    LatestEpochUnknown,
    /// These epochs failed to ingest.
    EpochsFailed(Vec<Epoch>),
}

impl std::fmt::Display for BackfillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoDurablePersistence => write!(
                f,
                "diff-backfill requires durable shape persistence: set S3_CACHE_BUCKET (and the \
                 AWS_* credentials for it) so ingested shapes are written to the result-cache \
                 bucket"
            ),
            Self::LatestEpochUnknown => {
                write!(f, "latest epoch discovery failed, nothing was ingested")
            }
            Self::EpochsFailed(epochs) => write!(f, "{} epochs failed", epochs.len()),
        }
    }
}

impl std::error::Error for BackfillError {}

/// One-shot: fill everything from `MIN_DZ_EPOCH` to the latest epoch, log a
/// summary, and return `Ok(())` only when every epoch is persisted. Refuses to
/// read anything when persistence is not durable, since nothing the run
/// ingested would survive the process. When the latest epoch cannot be
/// discovered nothing is ingested and the error names that, so a CLI caller
/// still exits non-zero.
pub async fn backfill_once(store: Arc<DiffStore>) -> Result<(), BackfillError> {
    if !store.has_durable_persistence() {
        tracing::error!(
            error = %BackfillError::NoDurablePersistence,
            "diff backfill: refusing to run"
        );
        return Err(BackfillError::NoDurablePersistence);
    }
    match fill(&store, FillPolicy::EveryEpoch).await {
        Some(summary) => {
            log_summary("diff backfill: complete", &summary);
            if summary.failed.is_empty() {
                Ok(())
            } else {
                Err(BackfillError::EpochsFailed(summary.failed))
            }
        }
        None => Err(BackfillError::LatestEpochUnknown),
    }
}

async fn fill(store: &DiffStore, policy: FillPolicy) -> Option<FillSummary> {
    let latest = match store.latest_epoch().await {
        Ok(latest) => latest,
        Err(error) => {
            tracing::error!(error = %error, "diff index: latest epoch discovery failed");
            return None;
        }
    };
    tracing::info!(latest = latest.0, "diff index: fill started");
    Some(summarize(latest, store.fill_missing(latest, policy).await))
}

fn summarize(latest: Epoch, outcomes: Vec<(Epoch, IngestOutcome)>) -> FillSummary {
    let mut summary = FillSummary {
        latest,
        ingested: 0,
        already_persisted: 0,
        missing: 0,
        deferred: 0,
        failed: Vec::new(),
    };
    for (epoch, outcome) in outcomes {
        match outcome {
            IngestOutcome::Ingested { .. } => summary.ingested += 1,
            IngestOutcome::AlreadyPersisted => summary.already_persisted += 1,
            IngestOutcome::Missing => summary.missing += 1,
            IngestOutcome::Deferred => summary.deferred += 1,
            IngestOutcome::Failed(_) => summary.failed.push(epoch),
        }
    }
    summary
}

fn log_summary(message: &'static str, summary: &FillSummary) {
    let failed: Vec<u32> = summary.failed.iter().map(|epoch| epoch.0).collect();
    if failed.is_empty() {
        tracing::info!(
            latest = summary.latest.0,
            ingested = summary.ingested,
            already_persisted = summary.already_persisted,
            missing = summary.missing,
            deferred = summary.deferred,
            message
        );
    } else {
        tracing::warn!(
            latest = summary.latest.0,
            ingested = summary.ingested,
            already_persisted = summary.already_persisted,
            missing = summary.missing,
            deferred = summary.deferred,
            failed_count = failed.len(),
            ?failed,
            message
        );
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::diff_store::NoPersistence;
    use crate::diff_store::test_support::{FakeReader, MemoryPersistence};
    use crate::snapshot::SnapshotReader;

    const TEST_WAIT: Duration = Duration::from_secs(10);

    fn store_over(reader: Arc<FakeReader>) -> Arc<DiffStore> {
        Arc::new(DiffStore::new(
            reader,
            Arc::new(MemoryPersistence::default()),
        ))
    }

    #[tokio::test]
    async fn backfill_once_ingests_every_epoch_up_to_latest_and_returns_failures() {
        let reader = Arc::new(FakeReader::with_epochs([48, 49, 50]));
        let store = store_over(Arc::clone(&reader));
        reader.fail_next_fetches(1);

        let outcome = backfill_once(Arc::clone(&store)).await;
        assert_eq!(
            outcome,
            Err(BackfillError::EpochsFailed(vec![Epoch(48)])),
            "one injected fetch failure must be reported"
        );
        assert_eq!(reader.fetch_calls(), 3);
        assert!(store.get(Epoch(50)).await.is_ok());
        assert_eq!(reader.fetch_calls(), 3);

        assert_eq!(backfill_once(Arc::clone(&store)).await, Ok(()));
        assert_eq!(reader.fetch_calls(), 4);
        assert!(store.get(Epoch(48)).await.is_ok());
        assert_eq!(reader.fetch_calls(), 4);
    }

    #[tokio::test]
    async fn backfill_once_refuses_to_read_anything_without_durable_persistence() {
        let reader = Arc::new(FakeReader::with_epochs([48, 49]));
        let shared_reader: Arc<dyn SnapshotReader> = reader.clone();
        let store = Arc::new(DiffStore::new(shared_reader, Arc::new(NoPersistence)));

        let outcome = backfill_once(store).await;

        assert_eq!(outcome, Err(BackfillError::NoDurablePersistence));
        assert_eq!(reader.fetch_calls(), 0);
        assert_eq!(reader.head_calls(), 0);
    }

    #[tokio::test]
    async fn backfill_once_fails_when_the_shapes_were_extracted_but_not_written() {
        let reader = Arc::new(FakeReader::with_epochs([48, 49]));
        let persistence = Arc::new(MemoryPersistence::default());
        persistence.fail_stores();
        let store = Arc::new(DiffStore::new(
            Arc::clone(&reader) as Arc<dyn SnapshotReader>,
            Arc::clone(&persistence) as Arc<dyn crate::diff_store::ShapePersistence>,
        ));

        let outcome = backfill_once(store).await;

        assert_eq!(
            outcome,
            Err(BackfillError::EpochsFailed(vec![Epoch(48), Epoch(49)])),
            "a shape that was never written must not count as ingested"
        );
        assert_eq!(persistence.store_calls(), 2);
    }

    #[test]
    fn backfill_error_displays_the_cause() {
        assert_eq!(
            BackfillError::EpochsFailed(vec![Epoch(48), Epoch(49)]).to_string(),
            "2 epochs failed"
        );
        assert_eq!(
            BackfillError::LatestEpochUnknown.to_string(),
            "latest epoch discovery failed, nothing was ingested"
        );
        assert!(
            BackfillError::NoDurablePersistence
                .to_string()
                .contains("S3_CACHE_BUCKET")
        );
    }

    #[tokio::test]
    async fn run_fills_on_its_first_tick() {
        let reader = Arc::new(FakeReader::with_epochs([48, 49]));
        let store = store_over(Arc::clone(&reader));

        let poller = tokio::spawn(run(Arc::clone(&store)));
        let deadline = Instant::now() + TEST_WAIT;
        while reader.fetch_calls() < 2 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        poller.abort();
        assert_eq!(reader.fetch_calls(), 2);
        assert!(store.get(Epoch(49)).await.is_ok());
        assert_eq!(reader.fetch_calls(), 2);
    }

    #[test]
    fn summarize_counts_each_outcome() {
        let summary = summarize(
            Epoch(51),
            vec![
                (Epoch(48), IngestOutcome::AlreadyPersisted),
                (
                    Epoch(49),
                    IngestOutcome::Ingested {
                        bytes_read: 10,
                        ms: 1,
                    },
                ),
                (Epoch(50), IngestOutcome::Missing),
                (Epoch(51), IngestOutcome::Failed("boom".to_string())),
                (Epoch(52), IngestOutcome::Deferred),
            ],
        );
        assert_eq!(summary.latest, Epoch(51));
        assert_eq!(summary.ingested, 1);
        assert_eq!(summary.already_persisted, 1);
        assert_eq!(summary.missing, 1);
        assert_eq!(summary.deferred, 1);
        assert_eq!(summary.failed, vec![Epoch(51)]);
    }
}
