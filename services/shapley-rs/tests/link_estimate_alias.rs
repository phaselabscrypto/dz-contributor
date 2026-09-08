//! `S3Cache::load_link_estimate_alias` tells a miss from an outage from bad
//! data, without a Redis or the HTTP layer.
mod support;

use dz_shapley_service::cache::{AliasReadError, S3Cache};
use serde_json::json;
use support::MockS3;

fn alias_key(tag: &str, focus: &str) -> String {
    format!(
        "shapley/v3/publication/v1/link-estimate-alias-{:016x}.json",
        dz_shapley_service::queue::hash_payload(&format!("{tag}\u{0}{focus}"))
    )
}

#[tokio::test]
async fn an_absent_alias_is_an_ordinary_miss() {
    let s3 = MockS3::start().await;
    let cache = S3Cache::from(s3.cache_ref());
    assert!(matches!(
        cache.load_link_estimate_alias("absent", "Alpha").await,
        Ok(None)
    ));
}

#[tokio::test]
async fn a_present_alias_yields_its_payload_hash() {
    let s3 = MockS3::start().await;
    s3.put(
        &alias_key("present", "Alpha"),
        json!({ "payloadHash": "00000000deadbeef" })
            .to_string()
            .into_bytes(),
        None,
    );
    let cache = S3Cache::from(s3.cache_ref());
    assert!(matches!(
        cache.load_link_estimate_alias("present", "Alpha").await,
        Ok(Some(0xdead_beef))
    ));
}

#[tokio::test]
async fn a_storage_failure_is_not_a_miss() {
    let s3 = MockS3::start().await;
    s3.state.storage.lock().unwrap().get_failure = Some(500);
    let cache = S3Cache::from(s3.cache_ref());
    let error = cache
        .load_link_estimate_alias("outage", "Alpha")
        .await
        .expect_err("a storage failure must be an error");
    assert!(matches!(error, AliasReadError::Storage { .. }));
    assert_eq!(error.to_string(), "alias store unavailable");
}

#[tokio::test]
async fn a_malformed_alias_is_an_error() {
    let s3 = MockS3::start().await;
    s3.put(&alias_key("not-json", "Alpha"), b"not json".to_vec(), None);
    s3.put(
        &alias_key("not-hex", "Alpha"),
        json!({ "payloadHash": "zz" }).to_string().into_bytes(),
        None,
    );
    s3.put(&alias_key("no-hash", "Alpha"), b"{}".to_vec(), None);
    let cache = S3Cache::from(s3.cache_ref());
    for tag in ["not-json", "not-hex", "no-hash"] {
        let error = cache
            .load_link_estimate_alias(tag, "Alpha")
            .await
            .expect_err("malformed data must be an error");
        assert!(matches!(error, AliasReadError::Malformed { .. }), "{tag}");
        assert_eq!(error.to_string(), "alias is malformed");
    }
}
