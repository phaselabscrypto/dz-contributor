#![allow(dead_code)]

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Method, Request, StatusCode},
    response::Response,
};
use dz_shapley_service::{
    cache::S3CacheRef,
    diff::{DiffShape, LinkRef},
    epoch::Epoch,
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

#[derive(Clone)]
pub struct Object {
    pub bytes: Vec<u8>,
    pub etag: Option<String>,
}
#[derive(Default)]
pub struct Storage {
    pub objects: HashMap<String, Object>,
    pub requests: Vec<(Method, String)>,
    pub conditions: Vec<(Option<String>, Option<String>)>,
    pub get_failure: Option<u16>,
    pub put_failure: Option<(String, u16)>,
    pub put_delay: Option<(String, Duration)>,
    pub get_delay: Duration,
    pub put_barrier: Option<Arc<tokio::sync::Barrier>>,
    version: usize,
}
#[derive(Clone, Default)]
pub struct MockState {
    pub storage: Arc<Mutex<Storage>>,
    pub active_reads: Arc<AtomicUsize>,
    pub peak_reads: Arc<AtomicUsize>,
}
pub struct MockS3 {
    pub state: MockState,
    pub client: aws_sdk_s3::Client,
    server: tokio::task::JoinHandle<()>,
}
impl MockS3 {
    pub async fn start() -> Self {
        let state = MockState::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback(handle).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            state,
            client: client(&endpoint),
            server,
        }
    }
    pub fn cache_ref(&self) -> S3CacheRef {
        S3CacheRef {
            client: self.client.clone(),
            bucket: "test".into(),
        }
    }
    pub fn put(&self, key: &str, bytes: Vec<u8>, etag: Option<&str>) {
        self.state.storage.lock().unwrap().objects.insert(
            format!("/test/{key}"),
            Object {
                bytes,
                etag: etag.map(str::to_owned),
            },
        );
    }
    pub fn bytes(&self, key: &str) -> Vec<u8> {
        self.state.storage.lock().unwrap().objects[&format!("/test/{key}")]
            .bytes
            .clone()
    }
    pub fn has(&self, key: &str) -> bool {
        self.state
            .storage
            .lock()
            .unwrap()
            .objects
            .contains_key(&format!("/test/{key}"))
    }
}
impl Drop for MockS3 {
    fn drop(&mut self) {
        self.server.abort();
    }
}

pub fn client(endpoint: &str) -> aws_sdk_s3::Client {
    use aws_sdk_s3::config::{
        BehaviorVersion, Credentials, Region, RequestChecksumCalculation, retry::RetryConfig,
    };
    aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::new("test", "test", None, None, "test"))
            .endpoint_url(endpoint)
            .force_path_style(true)
            .retry_config(RetryConfig::disabled())
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .build(),
    )
}
fn reply(status: u16, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .body(body.into())
        .unwrap()
}
async fn handle(State(state): State<MockState>, request: Request<Body>) -> Response {
    let method = request.method().clone();
    let key = request.uri().path().to_owned();
    let (get_failure, put_failure, put_delay, get_delay, barrier) = {
        let mut storage = state.storage.lock().unwrap();
        storage.requests.push((method.clone(), key.clone()));
        (
            storage.get_failure,
            storage.put_failure.clone(),
            storage.put_delay.clone(),
            storage.get_delay,
            storage.put_barrier.clone(),
        )
    };
    if method == Method::GET || method == Method::HEAD {
        let active = state.active_reads.fetch_add(1, Ordering::SeqCst) + 1;
        state.peak_reads.fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(get_delay).await;
        state.active_reads.fetch_sub(1, Ordering::SeqCst);
        if let Some(status) = get_failure {
            return reply(status, "<Error><Code>InternalError</Code></Error>");
        }
        return match state.storage.lock().unwrap().objects.get(&key).cloned() {
            Some(object) => {
                let mut response = Response::builder().status(StatusCode::OK);
                if let Some(etag) = object.etag {
                    response = response.header("ETag", etag);
                }
                response
                    .body(if method == Method::HEAD {
                        Body::empty()
                    } else {
                        Body::from(object.bytes)
                    })
                    .unwrap()
            }
            None => reply(404, "<Error><Code>NoSuchKey</Code></Error>"),
        };
    }
    if method != Method::PUT {
        return reply(405, "");
    }
    if let Some((needle, delay)) = put_delay
        && key.contains(&needle)
    {
        tokio::time::sleep(delay).await;
    }
    if let Some(barrier) = barrier {
        barrier.wait().await;
    }
    let absent = request
        .headers()
        .get("if-none-match")
        .map(|h| h.to_str().unwrap().to_owned());
    let etag = request
        .headers()
        .get("if-match")
        .map(|h| h.to_str().unwrap().to_owned());
    let bytes = to_bytes(request.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    let mut storage = state.storage.lock().unwrap();
    storage.conditions.push((absent.clone(), etag.clone()));
    if let Some((needle, status)) = put_failure
        && key.contains(&needle)
    {
        return reply(status, "<Error><Code>AccessDenied</Code></Error>");
    }
    if (absent.as_deref() == Some("*") && storage.objects.contains_key(&key))
        || etag.as_ref().is_some_and(|expected| {
            storage
                .objects
                .get(&key)
                .and_then(|object| object.etag.as_ref())
                != Some(expected)
        })
    {
        return reply(412, "<Error><Code>PreconditionFailed</Code></Error>");
    }
    storage.version += 1;
    let etag = format!("\"version-{}\"", storage.version);
    storage.objects.insert(
        key,
        Object {
            bytes,
            etag: Some(etag),
        },
    );
    reply(200, "")
}

pub fn shape(bandwidth: f64) -> DiffShape {
    DiffShape {
        epoch: Epoch(211),
        contributors: vec![],
        links: vec![LinkRef {
            pubkey: "test-link".into(),
            contributor_code: "test".into(),
            side_a_code: "a".into(),
            side_z_code: "z".into(),
            bandwidth_gbps: bandwidth,
            link_type: "WAN".into(),
        }],
    }
}
