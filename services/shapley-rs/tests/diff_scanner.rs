//! Scanner and diff tests over synthetic snapshots. Pure, no network.
//!
//! Run:  cargo test -p dz-shapley-service --test diff_scanner

mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use dz_shapley_service::diff::{
    ChangedField, EpochWindow, FieldValue, compute_contributor_diff, compute_network_diff,
    parse_sections, validate_window,
};
use dz_shapley_service::diff_store::{DiffStore, NoPersistence};
use dz_shapley_service::snapshot::{
    Epoch, MAX_SCAN_BYTES, ScanFailure, ScanResult, SectionScanner,
};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

fn sorted_keys(result: &ScanResult) -> Vec<&'static str> {
    let mut keys: Vec<&'static str> = result.sections.keys().copied().collect();
    keys.sort_unstable();
    keys
}

fn expected_keys() -> Vec<&'static str> {
    let mut keys = SECTION_KEYS.to_vec();
    keys.sort_unstable();
    keys
}

fn assert_sections_match_source(result: &ScanResult, source: &Node) {
    assert_eq!(sorted_keys(result), expected_keys());
    for key in SECTION_KEYS {
        let captured: Value =
            serde_json::from_slice(&result.sections[key]).expect("captured bytes parse");
        assert_eq!(captured, section_value(source, key), "section {key}");
    }
}

#[test]
fn single_chunk_captures_exactly_the_four_sections() {
    let snapshot = snapshot_a();
    let bytes = snapshot_bytes(&snapshot);
    let result = scan_chunked(EPOCH_A, &bytes, bytes.len()).unwrap();
    assert_eq!(result.epoch, EPOCH_A);
    assert!(result.is_cancelled_early);
    assert_sections_match_source(&result, &snapshot);
}

#[test]
fn chunk_size_does_not_change_the_result() {
    let snapshot = snapshot_a();
    let bytes = snapshot_bytes(&snapshot);
    let reference = scan_chunked(EPOCH_A, &bytes, 4096).unwrap();
    for chunk_size in [1, 7, 64, 4096] {
        let result = scan_chunked(EPOCH_A, &bytes, chunk_size).unwrap();
        assert_eq!(result.epoch, reference.epoch, "chunk size {chunk_size}");
        assert_eq!(
            result.sections, reference.sections,
            "chunk size {chunk_size}"
        );
        assert!(result.is_cancelled_early, "chunk size {chunk_size}");
    }
}

#[test]
fn targeted_splits_inside_tokens_do_not_disturb_the_scan() {
    let snapshot = snapshot_a();
    let bytes = snapshot_bytes(&snapshot);
    let after_backslash = offset_of(&bytes, "\\\"") + 1;
    let inside_e_acute = offset_of(&bytes, "é") + 1;
    let mid_contributors_key = offset_of(&bytes, "\"contributors\"") + 6;
    let links_key = offset_of(&bytes, "\"links\": {");
    let after_links_key = links_key + "\"links\"".len();
    let after_links_colon = links_key + "\"links\":".len();
    let before_links_brace = links_key + "\"links\": ".len();
    assert_eq!(bytes[before_links_brace], b'{');
    let exchanges_key = offset_of(&bytes, "\"exchanges\"");
    let locations_close = bytes[..exchanges_key]
        .iter()
        .rposition(|&byte| byte == b'}')
        .expect("locations closes before exchanges");

    let splits = [
        after_backslash,
        inside_e_acute,
        mid_contributors_key,
        after_links_key,
        after_links_colon,
        before_links_brace,
        locations_close,
    ];
    for split in splits {
        let result = scan_at_splits(EPOCH_A, &bytes, &[split]).unwrap();
        assert_sections_match_source(&result, &snapshot);
    }
    let mut all_splits = splits.to_vec();
    all_splits.sort_unstable();
    let result = scan_at_splits(EPOCH_A, &bytes, &all_splits).unwrap();
    assert_sections_match_source(&result, &snapshot);
}

#[test]
fn scan_stops_when_contributors_closes() {
    const CHUNK: usize = 4096;
    let bytes = snapshot_bytes(&snapshot_a());
    let access_passes = offset_of(&bytes, "\"access_passes\"");
    let mut scanner = SectionScanner::new(EPOCH_A);
    let mut stop_offset = None;
    for (index, chunk) in bytes.chunks(CHUNK).enumerate() {
        if scanner.push(chunk).unwrap() {
            stop_offset = Some((index + 1) * CHUNK);
            break;
        }
    }
    let stop_offset = stop_offset.expect("push returned Ok(true)");
    assert!(
        stop_offset < access_passes + CHUNK,
        "stopped at {stop_offset}, access_passes at {access_passes}"
    );
    assert!(scanner.bytes_read() < access_passes + CHUNK);
    let result = scanner.finish(false).unwrap();
    assert!(result.is_cancelled_early);
    assert!(
        result.bytes_read < bytes.len() / 2,
        "telemetry was not read"
    );
}

#[test]
fn decoys_never_produce_a_section() {
    let snapshot = snapshot_a();
    let bytes = snapshot_bytes(&snapshot);
    let result = scan_chunked(EPOCH_A, &bytes, 64).unwrap();
    assert_eq!(result.sections.len(), 4);
    assert_eq!(sorted_keys(&result), expected_keys());
    let links: Value = serde_json::from_slice(&result.sections["links"]).unwrap();
    let mut link_keys: Vec<&String> = links.as_object().unwrap().keys().collect();
    link_keys.sort();
    assert_eq!(link_keys, ["K1", "K2", "K3", "K5"]);
    let locations: Value = serde_json::from_slice(&result.sections["locations"]).unwrap();
    assert_eq!(locations["L2"]["name"], DECOY_NAME);
}

#[test]
fn reordered_sections_are_captured_and_the_scan_stops_at_the_fourth() {
    const CHUNK: usize = 4096;
    let reordered = snapshot_a_reordered();
    let bytes = snapshot_bytes(&reordered);
    let exchanges_key = offset_of(&bytes, "\"exchanges\"");
    let result = scan_chunked(EPOCH_A, &bytes, CHUNK).unwrap();
    assert!(result.is_cancelled_early);
    assert_sections_match_source(&result, &reordered);
    assert!(result.bytes_read < exchanges_key + CHUNK);

    let sections = parse_sections(&result).unwrap();
    let reordered_shape = dz_shapley_service::diff::extract_diff_shape(EPOCH_A, &sections);
    assert_eq!(reordered_shape, shape_of(EPOCH_A, &snapshot_a()));
}

#[test]
fn scan_failures_are_reported_by_kind() {
    let text = render(&snapshot_a());

    let missing_links = text.replacen("\"links\": {", "\"links_old\": {", 1);
    assert_eq!(
        scan_chunked(EPOCH_A, missing_links.as_bytes(), 512).unwrap_err(),
        ScanFailure::MissingSection("links")
    );

    let bytes = text.as_bytes();
    let cut = offset_of(bytes, "\"location_pk\"") + 5;
    assert_eq!(
        scan_chunked(EPOCH_A, &bytes[..cut], 512).unwrap_err(),
        ScanFailure::Truncated
    );

    let without_epoch = snapshot_bytes(&snapshot_a_without_epoch());
    assert_eq!(
        scan_chunked(EPOCH_A, &without_epoch, 512).unwrap_err(),
        ScanFailure::MissingEpoch
    );

    assert_eq!(
        scan_chunked(EPOCH_B, bytes, 512).unwrap_err(),
        ScanFailure::EpochMismatch { found: EPOCH_A }
    );

    let null_links = text.replacen("\"links\": {", "\"links\": null, \"links_old\": {", 1);
    assert_eq!(
        scan_chunked(EPOCH_A, null_links.as_bytes(), 512).unwrap_err(),
        ScanFailure::SectionNotObject("links")
    );

    const CHUNK: usize = 65_536;
    let filler = "x".repeat(40 * 1024 * 1024);
    let padded = text.replacen(
        "\"solana_epoch\": 900,",
        &format!("\"solana_epoch\": 900,\n  \"filler\": \"{filler}\","),
        1,
    );
    let mut scanner = SectionScanner::new(EPOCH_A);
    let mut failure = None;
    for chunk in padded.as_bytes().chunks(CHUNK) {
        match scanner.push(chunk) {
            Ok(true) => panic!("scan completed through the filler"),
            Ok(false) => {}
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    assert_eq!(failure, Some(ScanFailure::BudgetExceeded));
    assert!(scanner.bytes_read() > MAX_SCAN_BYTES);
    assert!(scanner.bytes_read() <= MAX_SCAN_BYTES + CHUNK);
}

#[test]
fn extract_diff_shape_resolves_codes_and_footprints() {
    let shape = shape_of(EPOCH_A, &snapshot_a());
    assert_eq!(shape.epoch, EPOCH_A);
    assert_eq!(shape.links.len(), 4);

    let k1 = &shape.links[0];
    assert_eq!(k1.pubkey, "K1");
    assert_eq!(k1.contributor_code, "alpha");
    assert_eq!(k1.side_a_code, "nyc");
    assert_eq!(k1.side_z_code, "lon");
    assert_eq!(k1.bandwidth_gbps, 10.0);
    assert_eq!(k1.link_type, "WAN");

    let k5 = shape.links.iter().find(|link| link.pubkey == "K5").unwrap();
    assert_eq!(k5.contributor_code, "unknown");
    assert_eq!(k5.side_a_code, "");
    assert_eq!(k5.side_z_code, "nyc");

    let codes: Vec<&str> = shape.contributors.iter().map(|c| c.code.as_str()).collect();
    assert_eq!(codes, ["alpha", "beta"]);
    let alpha = &shape.contributors[0];
    assert_eq!(
        (alpha.link_count, alpha.device_count, alpha.metro_count),
        (2, 2, 2)
    );
    let beta = &shape.contributors[1];
    assert_eq!(
        (beta.link_count, beta.device_count, beta.metro_count),
        (1, 1, 1)
    );
}

#[test]
fn contributor_diff_compares_only_bandwidth_and_link_type() {
    let before = shape_of(EPOCH_A, &snapshot_a());
    let after = shape_of(EPOCH_B, &snapshot_b());

    let alpha = compute_contributor_diff(&before, &after, "alpha", "now".to_string());
    assert_eq!(alpha.code, "alpha");
    assert_eq!(alpha.from, EPOCH_A);
    assert_eq!(alpha.to, EPOCH_B);
    assert!(alpha.added.is_empty());
    assert!(alpha.removed.is_empty());
    assert_eq!(alpha.changed.len(), 2);
    assert_eq!(alpha.changed[0].pubkey, "K1");
    assert_eq!(alpha.changed[0].before.bandwidth_gbps, 10.0);
    assert_eq!(alpha.changed[0].after.bandwidth_gbps, 20.0);
    assert_eq!(alpha.changed[1].pubkey, "K3");
    assert_eq!(alpha.changed[1].before.link_type, "WAN");
    assert_eq!(alpha.changed[1].after.link_type, "DZX");
    assert_eq!(alpha.summary.links_changed, 2);
    assert_eq!(alpha.summary.bandwidth_gbps_before, 50.0);
    assert_eq!(alpha.summary.bandwidth_gbps_after, 60.0);
    assert_eq!(alpha.summary.bandwidth_gbps_delta, 10.0);
    assert_eq!(alpha.footprint.before.link_count, 2);
    assert!(!alpha.footprint.first_seen);
    assert!(!alpha.footprint.left_network);

    let beta = compute_contributor_diff(&before, &after, "beta", "now".to_string());
    assert_eq!(
        beta.added
            .iter()
            .map(|l| l.pubkey.as_str())
            .collect::<Vec<_>>(),
        ["K4"]
    );
    assert_eq!(
        beta.removed
            .iter()
            .map(|l| l.pubkey.as_str())
            .collect::<Vec<_>>(),
        ["K2"]
    );
    assert!(beta.changed.is_empty());
    assert_eq!(
        (
            beta.summary.links_added,
            beta.summary.links_removed,
            beta.summary.links_changed
        ),
        (1, 1, 0)
    );

    let same = compute_contributor_diff(&before, &before, "alpha", "now".to_string());
    assert!(same.added.is_empty() && same.removed.is_empty() && same.changed.is_empty());
    assert_eq!(same.summary.bandwidth_gbps_delta, 0.0);

    let reversed = compute_contributor_diff(&after, &before, "beta", "now".to_string());
    assert_eq!(
        reversed
            .added
            .iter()
            .map(|l| l.pubkey.as_str())
            .collect::<Vec<_>>(),
        ["K2"]
    );
    assert_eq!(
        reversed
            .removed
            .iter()
            .map(|l| l.pubkey.as_str())
            .collect::<Vec<_>>(),
        ["K4"]
    );

    let gamma = compute_contributor_diff(&before, &after, "gamma", "now".to_string());
    assert!(gamma.footprint.first_seen);
    let json = serde_json::to_value(&gamma).unwrap();
    assert!(json.get("name").is_none());
    assert_eq!(json["footprint"]["firstSeen"], true);
}

#[test]
fn network_diff_orders_entries_and_attributes_changes() {
    let before = shape_of(EPOCH_A, &snapshot_a());
    let after = shape_of(EPOCH_B, &snapshot_b());
    let response = compute_network_diff(&before, &after, &[], "now".to_string());

    assert_eq!(response.from, EPOCH_A);
    assert_eq!(response.to, EPOCH_B);
    assert_eq!(
        response
            .added
            .iter()
            .map(|e| e.link.pubkey.as_str())
            .collect::<Vec<_>>(),
        ["K4"]
    );
    assert_eq!(
        response
            .removed
            .iter()
            .map(|e| e.link.pubkey.as_str())
            .collect::<Vec<_>>(),
        ["K2"]
    );
    let changed: Vec<(&str, ChangedField)> = response
        .changed
        .iter()
        .map(|entry| (entry.pubkey.as_str(), entry.field))
        .collect();
    assert_eq!(
        changed,
        [
            ("K1", ChangedField::BandwidthGbps),
            ("K3", ChangedField::LinkType)
        ]
    );
    assert_eq!(response.changed[0].before, FieldValue::Number(10.0));
    assert_eq!(response.changed[0].after, FieldValue::Number(20.0));
    assert_eq!(
        response.changed[1].before,
        FieldValue::Text("WAN".to_string())
    );
    assert_eq!(
        response.changed[1].after,
        FieldValue::Text("DZX".to_string())
    );
    assert!(
        response
            .added
            .iter()
            .all(|e| e.first_observed_epoch == EPOCH_B)
    );
    assert!(
        response
            .removed
            .iter()
            .all(|e| e.first_observed_epoch == EPOCH_B)
    );
    assert!(
        response
            .changed
            .iter()
            .all(|e| e.first_observed_epoch == EPOCH_B)
    );
    assert_eq!(response.summary.links_added, 1);
    assert_eq!(response.summary.links_removed, 1);
    assert_eq!(response.summary.links_changed, 2);
    assert_eq!(response.summary.contributors_affected, 3);

    let codes: Vec<&str> = response
        .contributors
        .iter()
        .map(|row| row.code.as_str())
        .collect();
    assert_eq!(codes, ["beta", "alpha", "gamma"]);
    assert_eq!(response.contributors[0].bandwidth_gbps_delta, -90.0);
    assert_eq!(response.contributors[1].bandwidth_gbps_delta, 10.0);
    assert!(response.contributors[2].first_seen);
    assert!(
        response
            .contributors
            .iter()
            .all(|row| row.code != "unknown")
    );

    let unchanged = compute_network_diff(&before, &before, &[], "now".to_string());
    assert!(unchanged.contributors.is_empty());
    assert_eq!(unchanged.summary.contributors_affected, 0);

    let mut later = after.clone();
    later.epoch = Epoch(150);
    let attributed = compute_network_diff(&before, &later, &[Arc::new(after)], "now".to_string());
    assert_eq!(attributed.to, Epoch(150));
    assert!(
        attributed
            .added
            .iter()
            .all(|e| e.first_observed_epoch == EPOCH_B)
    );
    assert!(
        attributed
            .removed
            .iter()
            .all(|e| e.first_observed_epoch == EPOCH_B)
    );
    assert!(
        attributed
            .changed
            .iter()
            .all(|e| e.first_observed_epoch == EPOCH_B)
    );

    let json = serde_json::to_value(&response).unwrap();
    assert_eq!(json["changed"][0]["field"], "bandwidthGbps");
    assert_eq!(json["changed"][1]["field"], "linkType");
    assert_eq!(json["added"][0]["firstObservedEpoch"], 149);
    assert_eq!(json["contributors"][0]["bandwidthGbpsDelta"], -90.0);
}

#[test]
fn validate_window_emits_the_route_messages() {
    assert_eq!(
        validate_window(Some("1"), Some("2")),
        Err("from and to must be in [48, 100000]")
    );
    assert_eq!(
        validate_window(Some("48"), Some("49")),
        Ok(EpochWindow {
            from: Epoch(48),
            to: Epoch(49),
        })
    );
    assert_eq!(
        validate_window(Some("48"), Some("300")),
        Err("epoch window too wide: |to - from| must be <= 200")
    );
    assert_eq!(
        validate_window(Some("x"), Some("2")),
        Err("from and to query params required (different integers)")
    );
}

fn diff_app() -> axum::Router {
    let mut reader = FakeSnapshotReader::new(4096);
    reader.insert(EPOCH_A, &snapshot_a());
    reader.insert(EPOCH_B, &snapshot_b());
    let state = Arc::new(dz_shapley_service::AppState {
        epoch_cache: tokio::sync::RwLock::new(None),
        s3_cache: None,
        api_token: None,
        jobs: None,
        diff_store: Arc::new(DiffStore::new(Arc::new(reader), Arc::new(NoPersistence))),
    });
    dz_shapley_service::diff_routes::routes().with_state(state)
}

async fn call(app: axum::Router, method: &str, uri: &str) -> (StatusCode, String) {
    let response = app
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
    (
        status,
        String::from_utf8(bytes.to_vec()).expect("utf-8 body"),
    )
}

fn key_offsets(body: &str, keys: &[&str]) -> Vec<usize> {
    keys.iter()
        .map(|key| {
            body.find(&format!("\"{key}\":"))
                .unwrap_or_else(|| panic!("key {key} missing"))
        })
        .collect()
}

#[tokio::test]
async fn route_layer_serves_the_diff_endpoints() {
    let (status, body) = call(diff_app(), "GET", "/diff?from=148&to=149").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let offsets = key_offsets(
        &body,
        &[
            "from",
            "to",
            "summary",
            "contributors",
            "added",
            "removed",
            "changed",
            "fetchedAt",
        ],
    );
    assert!(offsets.windows(2).all(|pair| pair[0] < pair[1]), "{body}");
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["summary"]["linksAdded"], 1);
    assert_eq!(json["summary"]["linksRemoved"], 1);
    assert_eq!(json["added"][0]["pubkey"], "K4");
    assert_eq!(json["removed"][0]["pubkey"], "K2");

    let (status, body) = call(diff_app(), "GET", "/diff?from=1&to=2").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["error"], "from and to must be in [48, 100000]");

    let (status, body) = call(diff_app(), "GET", "/diff?from=148&to=300").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["error"], "epoch 300: snapshot HTTP 404");

    let (status, body) = call(diff_app(), "GET", "/diff/contributor/alpha?from=148&to=149").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["code"], "alpha");
    assert!(json.get("name").is_none());
    assert_eq!(json["summary"]["linksChanged"], 2);

    let (status, body) = call(diff_app(), "POST", "/diff/precompute?epoch=149").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["results"].as_array().map(Vec::len), Some(1));
    assert_eq!(json["results"][0]["epoch"], 149);
    assert_eq!(json["results"][0]["status"], "ok");
}
