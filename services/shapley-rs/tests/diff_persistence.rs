mod support;
use dz_shapley_service::{
    diff_error::DiffStoreError,
    diff_store::{
        ConditionalWriteOutcome, DiffStore, S3ShapePersistence, ShapePersistence, ShapeRead,
        ShapeWriteCondition,
    },
    epoch::Epoch,
};
use std::{sync::Arc, time::Duration};
use support::{MockS3, shape};
const KEY: &str = "diff/v1/shape-000211.json";
fn store(s3: &MockS3) -> DiffStore {
    DiffStore::new(Arc::new(S3ShapePersistence::from(s3.cache_ref())))
}

#[tokio::test]
async fn failed_get_preserves_healthy_bytes() {
    let s3 = MockS3::start().await;
    let original = serde_json::to_vec(&shape(10.0)).unwrap();
    s3.put(KEY, original.clone(), Some("\"healthy\""));
    s3.state.storage.lock().unwrap().get_failure = Some(503);
    assert!(matches!(
        store(&s3).put(shape(999.0)).await,
        Err(DiffStoreError::Persistence { .. })
    ));
    assert!(s3.state.storage.lock().unwrap().conditions.is_empty());
    assert_eq!(s3.bytes(KEY), original);
}
#[tokio::test]
async fn create_and_repair_send_storage_conditions() {
    let s3 = MockS3::start().await;
    store(&s3).put(shape(10.0)).await.unwrap();
    assert_eq!(
        s3.state.storage.lock().unwrap().conditions[0],
        (Some("*".into()), None)
    );
    assert!(matches!(
        store(&s3).put(shape(20.0)).await,
        Err(DiffStoreError::Conflict { .. })
    ));
    assert_eq!(s3.state.storage.lock().unwrap().conditions.len(), 1);
    s3.put(KEY, b"invalid".to_vec(), Some("\"corrupt-etag\""));
    store(&s3).put(shape(30.0)).await.unwrap();
    assert_eq!(
        s3.state.storage.lock().unwrap().conditions[1],
        (None, Some("\"corrupt-etag\"".into()))
    );
    s3.put(KEY, b"invalid".to_vec(), None);
    assert!(matches!(
        store(&s3).put(shape(40.0)).await,
        Err(DiffStoreError::Persistence { .. })
    ));
    assert_eq!(s3.state.storage.lock().unwrap().conditions.len(), 2);
}
#[tokio::test]
async fn concurrent_creates_and_repairs_converge_on_one_winner() {
    for is_repair in [false, true] {
        let s3 = MockS3::start().await;
        if is_repair {
            s3.put(KEY, b"bad".to_vec(), Some("\"bad\""));
        }
        s3.state.storage.lock().unwrap().put_barrier = Some(Arc::new(tokio::sync::Barrier::new(2)));
        let first = store(&s3);
        let second = store(&s3);
        let (a, b) = tokio::join!(first.put(shape(10.0)), second.put(shape(999.0)));
        assert!(matches!(
            (&a, &b),
            (Ok(()), Err(DiffStoreError::Conflict { .. }))
                | (Err(DiffStoreError::Conflict { .. }), Ok(()))
        ));
        assert_eq!(
            first.get(Epoch(211)).await.unwrap().links[0].bandwidth_gbps,
            second.get(Epoch(211)).await.unwrap().links[0].bandwidth_gbps
        );
    }
}
#[tokio::test]
async fn conditional_conflict_without_readable_winner_is_an_error() {
    for status in [409, 412] {
        let s3 = MockS3::start().await;
        s3.state.storage.lock().unwrap().put_failure = Some(("shape-".into(), status));
        assert!(matches!(
            store(&s3).put(shape(10.0)).await,
            Err(DiffStoreError::Persistence { .. })
        ));
        assert!(!s3.has(KEY));
    }
}
#[tokio::test]
async fn discovery_finds_corrupt_and_mislabeled_durable_records() {
    let s3 = MockS3::start().await;
    s3.put(
        KEY,
        serde_json::to_vec(&shape(10.0)).unwrap(),
        Some("\"healthy\""),
    );
    let store = store(&s3);
    store.get(Epoch(211)).await.unwrap();
    s3.put(KEY, b"invalid".to_vec(), Some("\"bad\""));
    assert_eq!(
        store.missing_epochs(Epoch(211), 1).await.unwrap(),
        vec![Epoch(211)]
    );
    let mut mislabeled = shape(10.0);
    mislabeled.epoch = Epoch(210);
    s3.put(
        KEY,
        serde_json::to_vec(&mislabeled).unwrap(),
        Some("\"wrong\""),
    );
    assert_eq!(
        store.missing_epochs(Epoch(211), 1).await.unwrap(),
        vec![Epoch(211)]
    );
    assert!(matches!(super_read(&s3).await, ShapeRead::Corrupt { .. }));
}
async fn super_read(s3: &MockS3) -> ShapeRead {
    S3ShapePersistence::from(s3.cache_ref())
        .load(Epoch(211))
        .await
        .unwrap()
}
#[tokio::test]
async fn discovery_bounds_concurrency_and_whole_query_duration() {
    let s3 = MockS3::start().await;
    s3.state.storage.lock().unwrap().get_delay = Duration::from_millis(450);
    let started = std::time::Instant::now();
    assert!(store(&s3).missing_epochs(Epoch(247), 200).await.is_err());
    assert!(started.elapsed() < Duration::from_secs(12));
    assert!(
        s3.state
            .peak_reads
            .load(std::sync::atomic::Ordering::SeqCst)
            <= 8
    );
}
#[tokio::test]
async fn incomplete_and_reset_bodies_never_allow_put() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for response in [
        b"".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 500\r\nETag: \"good\"\r\n\r\n{}",
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = support::client(&format!("http://{}", listener.local_addr().unwrap()));
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let received = socket.read(&mut buffer).await.unwrap();
            assert!(received > 0);
            socket.write_all(response).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let store = DiffStore::new(Arc::new(S3ShapePersistence::from(
            dz_shapley_service::cache::S3CacheRef {
                client,
                bucket: "test".into(),
            },
        )));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(3), store.put(shape(999.0)))
                .await
                .unwrap(),
            Err(DiffStoreError::Persistence { .. })
        ));
        task.await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires a disposable pr24-canary-UUID bucket on the deployed gateway"]
async fn gateway_conditional_contract() {
    use dz_shapley_service::cache::S3CacheRef;
    let bucket = std::env::var("TEST_S3_BUCKET").expect("TEST_S3_BUCKET required");
    let id = bucket
        .strip_prefix("pr24-canary-")
        .expect("disposable canary bucket required");
    uuid::Uuid::parse_str(id).expect("canary bucket must end in UUID");
    assert_ne!(
        std::env::var("S3_CACHE_BUCKET").ok().as_deref(),
        Some(bucket.as_str())
    );
    let endpoint = std::env::var("TEST_S3_ENDPOINT").expect("TEST_S3_ENDPOINT required");
    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .load()
        .await;
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::config::Builder::from(&config)
            .endpoint_url(endpoint)
            .force_path_style(true)
            .build(),
    );
    assert!(
        client
            .head_object()
            .bucket(&bucket)
            .key(KEY)
            .send()
            .await
            .unwrap_err()
            .as_service_error()
            .is_some_and(|e| e.is_not_found()),
        "canary key already exists or is inaccessible"
    );
    let persistence = S3ShapePersistence::from(S3CacheRef {
        client: client.clone(),
        bucket: bucket.clone(),
    });
    let (first, second) = (shape(10.0), shape(20.0));
    let (a, b) = tokio::join!(
        persistence.store_conditional(&first, ShapeWriteCondition::Absent),
        persistence.store_conditional(&second, ShapeWriteCondition::Absent)
    );
    assert!(matches!(
        (a.unwrap(), b.unwrap()),
        (
            ConditionalWriteOutcome::Stored,
            ConditionalWriteOutcome::PreconditionFailed
        ) | (
            ConditionalWriteOutcome::PreconditionFailed,
            ConditionalWriteOutcome::Stored
        )
    ));
    let response = client
        .get_object()
        .bucket(&bucket)
        .key(KEY)
        .send()
        .await
        .unwrap();
    let etag = response.e_tag().expect("gateway ETag").to_owned();
    let (first, second) = (shape(30.0), shape(40.0));
    let (a, b) = tokio::join!(
        persistence.store_conditional(&first, ShapeWriteCondition::MatchEtag(etag.clone())),
        persistence.store_conditional(&second, ShapeWriteCondition::MatchEtag(etag))
    );
    assert!(matches!(
        (a.unwrap(), b.unwrap()),
        (
            ConditionalWriteOutcome::Stored,
            ConditionalWriteOutcome::PreconditionFailed
        ) | (
            ConditionalWriteOutcome::PreconditionFailed,
            ConditionalWriteOutcome::Stored
        )
    ));
    let before = client
        .get_object()
        .bucket(&bucket)
        .key(KEY)
        .send()
        .await
        .unwrap()
        .body
        .collect()
        .await
        .unwrap()
        .into_bytes();
    assert_eq!(
        persistence
            .store_conditional(
                &shape(999.0),
                ShapeWriteCondition::MatchEtag("\"stale\"".into())
            )
            .await
            .unwrap(),
        ConditionalWriteOutcome::PreconditionFailed
    );
    let after = client
        .get_object()
        .bucket(&bucket)
        .key(KEY)
        .send()
        .await
        .unwrap()
        .body
        .collect()
        .await
        .unwrap()
        .into_bytes();
    assert_eq!(before, after);
    client
        .delete_object()
        .bucket(&bucket)
        .key(KEY)
        .send()
        .await
        .unwrap();
}
