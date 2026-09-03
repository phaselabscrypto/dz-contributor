//! Live parity: ingest epochs 204 through 211 from the public snapshot
//! bucket and compare both diffs against the production captures under
//! `tests/fixtures/diff/`. Eight reads of about 3.7 MB each, no LP work.
//!
//! Run:  cargo test --test diff_parity_live -- --ignored --nocapture
//!
//! Skips (does not fail) when the bucket is unreachable.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use dz_shapley_service::diff::{compute_contributor_diff, compute_network_diff};
use dz_shapley_service::diff_store::{DiffStore, NoPersistence};
use dz_shapley_service::snapshot::{
    BoxFuture, Epoch, S3SnapshotReader, ScanResult, SnapshotError, SnapshotReader,
};
use serde_json::Value;

const FROM: Epoch = Epoch(204);
const TO: Epoch = Epoch(211);
const CONTRIBUTOR: &str = "tsw";
const FLOAT_TOLERANCE: f64 = 1e-9;
const MAX_BYTES_PER_EPOCH: usize = 16 * 1024 * 1024;
const IGNORED_KEYS: [&str; 2] = ["fetchedAt", "name"];

struct ScanStats {
    epoch: Epoch,
    bytes_read: usize,
    is_cancelled_early: bool,
}

/// Delegates to the S3 reader and records every scan's size and early stop.
struct RecordingReader {
    inner: S3SnapshotReader,
    stats: Mutex<Vec<ScanStats>>,
}

impl SnapshotReader for RecordingReader {
    fn fetch_sections(&self, epoch: Epoch) -> BoxFuture<'_, Result<ScanResult, SnapshotError>> {
        Box::pin(async move {
            let result = self.inner.fetch_sections(epoch).await?;
            self.stats
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(ScanStats {
                    epoch: result.epoch,
                    bytes_read: result.bytes_read,
                    is_cancelled_early: result.is_cancelled_early,
                });
            Ok(result)
        })
    }

    fn has_snapshot(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, SnapshotError>> {
        self.inner.has_snapshot(epoch)
    }
}

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/diff")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).expect("fixture is JSON")
}

fn is_unreachable(error: &SnapshotError) -> bool {
    matches!(
        error,
        SnapshotError::Transport { .. } | SnapshotError::Timeout { .. }
    )
}

fn assert_json_close(expected: &Value, actual: &Value, path: &str) {
    match (expected, actual) {
        (Value::Object(expected_map), Value::Object(actual_map)) => {
            let expected_keys: Vec<&String> = expected_map
                .keys()
                .filter(|key| !IGNORED_KEYS.contains(&key.as_str()))
                .collect();
            let actual_keys: Vec<&String> = actual_map
                .keys()
                .filter(|key| !IGNORED_KEYS.contains(&key.as_str()))
                .collect();
            assert_eq!(expected_keys, actual_keys, "keys at {path}");
            for key in expected_keys {
                assert_json_close(
                    &expected_map[key],
                    &actual_map[key],
                    &format!("{path}.{key}"),
                );
            }
        }
        (Value::Array(expected_items), Value::Array(actual_items)) => {
            assert_eq!(expected_items.len(), actual_items.len(), "length at {path}");
            for (index, (expected_item, actual_item)) in
                expected_items.iter().zip(actual_items).enumerate()
            {
                assert_json_close(expected_item, actual_item, &format!("{path}[{index}]"));
            }
        }
        (Value::Number(expected_number), Value::Number(actual_number)) => {
            let expected_value = expected_number.as_f64().expect("finite number");
            let actual_value = actual_number.as_f64().expect("finite number");
            assert!(
                (expected_value - actual_value).abs() <= FLOAT_TOLERANCE,
                "number at {path}: expected {expected_value}, got {actual_value}"
            );
        }
        _ => assert_eq!(expected, actual, "value at {path}"),
    }
}

fn pubkeys(document: &Value, key: &str) -> Vec<String> {
    document[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is an array"))
        .iter()
        .map(|entry| entry["pubkey"].as_str().expect("pubkey text").to_string())
        .collect()
}

fn first_observed(document: &Value, key: &str) -> Vec<u64> {
    document[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is an array"))
        .iter()
        .map(|entry| {
            entry["firstObservedEpoch"]
                .as_u64()
                .expect("firstObservedEpoch number")
        })
        .collect()
}

#[tokio::test]
#[ignore = "network: reads eight snapshots from the public bucket"]
async fn live_diffs_match_the_production_captures() {
    let reader = Arc::new(RecordingReader {
        inner: S3SnapshotReader::from_env().await,
        stats: Mutex::new(Vec::new()),
    });
    let store = DiffStore::new(
        Arc::clone(&reader) as Arc<dyn SnapshotReader>,
        Arc::new(NoPersistence),
    );

    let mut shapes = Vec::new();
    for number in FROM.0..=TO.0 {
        let epoch = Epoch(number);
        match store.get(epoch).await {
            Ok(shape) => shapes.push(shape),
            Err(error) if is_unreachable(&error) => {
                eprintln!("SKIP diff_parity_live: snapshot bucket unreachable ({error})");
                return;
            }
            Err(error) => panic!("ingest {epoch}: {error}"),
        }
    }

    {
        let stats = reader.stats.lock().unwrap_or_else(PoisonError::into_inner);
        assert_eq!(stats.len(), shapes.len(), "one scan per epoch");
        for stat in stats.iter() {
            eprintln!(
                "epoch {}: {} bytes, cancelled early = {}",
                stat.epoch, stat.bytes_read, stat.is_cancelled_early
            );
            assert!(
                stat.bytes_read < MAX_BYTES_PER_EPOCH,
                "epoch {} read {} bytes",
                stat.epoch,
                stat.bytes_read
            );
            assert!(
                stat.is_cancelled_early,
                "epoch {} read to the end",
                stat.epoch
            );
        }
    }

    let before = shapes.first().expect("from shape");
    let after = shapes.last().expect("to shape");
    let intermediates: Vec<_> = shapes[1..shapes.len() - 1].to_vec();

    let network = serde_json::to_value(compute_network_diff(
        before,
        after,
        &intermediates,
        String::new(),
    ))
    .expect("network diff serializes");
    let expected_network = fixture("network-204-211.json");
    // Comparing two empty arrays asserts nothing, so pin what this window is
    // known to carry. It has one removal attributed to epoch 208 and three
    // endpoint changes attributed to 205. It has no addition, and no
    // bandwidthGbps or linkType change, so those paths are covered only by the
    // offline tests in src/diff.rs and tests/diff_scanner.rs.
    assert!(
        !pubkeys(&expected_network, "removed").is_empty(),
        "the network fixture must keep its attributed removal"
    );
    assert!(
        !pubkeys(&expected_network, "changed").is_empty(),
        "the network fixture must keep its attributed changes"
    );
    for key in ["added", "removed", "changed"] {
        assert_eq!(
            pubkeys(&expected_network, key),
            pubkeys(&network, key),
            "{key} pubkeys"
        );
        assert_eq!(
            first_observed(&expected_network, key),
            first_observed(&network, key),
            "{key} firstObservedEpoch"
        );
    }
    assert_json_close(&expected_network, &network, "network");

    let contributor = serde_json::to_value(compute_contributor_diff(
        before,
        after,
        CONTRIBUTOR,
        String::new(),
    ))
    .expect("contributor diff serializes");
    let expected_contributor = fixture("contributor-tsw-204-211.json");
    assert!(
        contributor.get("name").is_none(),
        "service body carries no name"
    );
    // This contributor's added/removed/changed are all empty over this window,
    // so the footprint and the bandwidth totals are the only real signal here.
    assert!(
        expected_contributor["footprint"]["before"]["linkCount"]
            .as_u64()
            .is_some_and(|count| count > 0),
        "the contributor fixture must keep a non-empty footprint"
    );
    for key in ["added", "removed", "changed"] {
        assert_eq!(
            pubkeys(&expected_contributor, key),
            pubkeys(&contributor, key),
            "{key} pubkeys"
        );
    }
    assert_json_close(&expected_contributor, &contributor, "contributor");
    eprintln!("diff_parity_live: both diffs match the production captures");
}
