//! Wire parity: the two diff bodies this service returns must not change.
//!
//! Loads the committed per-epoch shapes for 204 through 211, runs the pure
//! diffs over them, and compares against JSON captured from production before
//! any of this code changed. This is the only test that pins field names,
//! values and array ordering of the `/diff` responses.
//!
//! It used to read eight snapshots from the public bucket through the Rust
//! scanner. The scanner now lives in the Next.js cron
//! (`lib/utils/diff-shape.ts`), so the shapes are fixtures here and
//! `pnpm run test:diff-shape` is what checks the extractor still produces them.
//! Together the two cover what the single live test used to.

use std::path::PathBuf;
use std::sync::Arc;

use dz_shapley_service::diff::{DiffShape, compute_contributor_diff, compute_network_diff};
use dz_shapley_service::epoch::Epoch;
use serde_json::Value;

const FROM: Epoch = Epoch(204);
const TO: Epoch = Epoch(211);
const CONTRIBUTOR: &str = "tsw";
const FLOAT_TOLERANCE: f64 = 1e-9;
const IGNORED_KEYS: [&str; 2] = ["fetchedAt", "name"];

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/diff")
}

fn fixture(name: &str) -> Value {
    let path = fixture_dir().join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).expect("fixture is JSON")
}

/// One epoch's committed shape, or `None` when the shapes have not been
/// generated yet. Regenerate with `pnpm run test:diff-shape -- --write`.
fn shape(epoch: Epoch) -> Option<DiffShape> {
    let path = fixture_dir().join(format!("shapes/epoch-{:06}.json", epoch.0));
    let text = std::fs::read_to_string(&path).ok()?;
    Some(
        serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("{} is not a DiffShape: {error}", path.display())),
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

#[test]
fn diffs_over_the_committed_shapes_match_the_production_captures() {
    let mut shapes = Vec::new();
    for number in FROM.0..=TO.0 {
        let epoch = Epoch(number);
        match shape(epoch) {
            Some(shape) => {
                assert_eq!(
                    shape.epoch, epoch,
                    "fixture epoch-{number:06}.json is mislabelled"
                );
                shapes.push(Arc::new(shape));
            }
            None => {
                eprintln!(
                    "SKIP diff_parity: tests/fixtures/diff/shapes is not populated. \
                     Generate it with `pnpm run test:diff-shape -- --write`."
                );
                return;
            }
        }
    }

    let before = shapes.first().expect("from shape");
    let after = shapes.last().expect("to shape");
    let intermediates: Vec<Arc<DiffShape>> = shapes[1..shapes.len() - 1].to_vec();

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
    // offline tests in src/diff.rs.
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
    eprintln!("diff_parity: both diffs match the production captures");
}
