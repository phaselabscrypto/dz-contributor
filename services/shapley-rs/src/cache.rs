//! Epoch-level per-city Shapley value cache with S3 persistence.
//!
//! Caches each source city's per-operator Shapley values so that repeated
//! computations (e.g., what-if simulations adding/removing links) can reuse
//! the cities they didn't change instead of re-solving every per-city LP.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use aws_config::timeout::TimeoutConfig;
use serde::{Deserialize, Serialize};

use crate::model::{BaselineAlias, BaselineVariant, ShapleyOperatorOut, ShapleyResponse};

/// Cached per-city Shapley values + aggregated baseline for a network topology.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpochCache {
    /// Hash of the input that produced this cache.
    pub input_hash: u64,
    /// Raw (UN-weighted) per-city Shapley values: source city → [(operator,
    /// value)], operator-sorted. The reusable unit for what-if runs under the
    /// per-city architecture — a modified run reuses the source cities it didn't
    /// change (see `routes::reusable_city_values`).
    pub per_city_values: BTreeMap<String, Vec<(String, f64)>>,
    /// Pre-computed aggregated (stake-weighted, normalized) baseline result.
    pub baseline_values: Option<BaselineResult>,
}

/// Cached baseline Shapley computation result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaselineResult {
    pub method: String,
    pub operator_count: usize,
    pub values: HashMap<String, OperatorCache>,
}

/// Per-operator cached Shapley value and share.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorCache {
    pub value: f64,
    pub share: f64,
}

impl EpochCache {
    /// Create a new empty cache for the given input hash.
    pub fn new(input_hash: u64) -> Self {
        Self {
            input_hash,
            per_city_values: BTreeMap::new(),
            baseline_values: None,
        }
    }
}

/// Build a wire `ShapleyResponse` from a cached baseline result.
pub(crate) fn response_from_baseline(baseline: &BaselineResult) -> ShapleyResponse {
    let values: BTreeMap<String, ShapleyOperatorOut> = baseline
        .values
        .iter()
        .map(|(op, oc)| {
            (
                op.clone(),
                ShapleyOperatorOut {
                    value: oc.value,
                    share: oc.share,
                },
            )
        })
        .collect();
    ShapleyResponse {
        method: baseline.method.clone(),
        operator_count: baseline.operator_count,
        values,
    }
}

/// Why a baseline alias read produced no answer. `detail` is for logs only and
/// never reaches a client.
#[derive(Debug)]
pub enum BaselineAliasError {
    /// The object store failed the read.
    Storage {
        /// Underlying error text, for logs.
        detail: String,
    },
    /// The object exists but is not an alias for the requested tag.
    Malformed {
        /// What was wrong, for logs.
        detail: String,
    },
}

impl fmt::Display for BaselineAliasError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage { .. } => f.write_str("baseline store unavailable"),
            Self::Malformed { .. } => f.write_str("baseline alias is malformed"),
        }
    }
}

impl std::error::Error for BaselineAliasError {}

/// Compute a deterministic hash of the Shapley input for cache keying.
///
/// Uses JSON serialisation to produce a stable representation, then hashes
/// the resulting string. Two structurally identical inputs will produce
/// the same hash regardless of field ordering in the original struct.
///
/// The serialised form includes `city_weights`, so the baseline cache key
/// captures the aggregation weights too. This is intentional: the cached
/// `baseline_values` are stake-weighted, so a different weight vector MUST key a
/// different entry rather than silently reuse a stale aggregate.
/// Weights are epoch-stable (a deterministic function of the leader schedule),
/// so this never fragments the cache in practice.
pub fn hash_input(input: &crate::model::ShapleyInputIn) -> u64 {
    use std::hash::DefaultHasher;
    let json = serde_json::to_string(input).unwrap_or_else(|e| {
        // Should be unreachable for these plain structs. Log rather than
        // silently collapsing every serialize failure to the same cache key
        // (which would serve one input's cached result for another) — #19.
        tracing::error!(error = %e, "hash_input: failed to serialise input");
        String::new()
    });
    let mut hasher = DefaultHasher::new();
    json.hash(&mut hasher);
    hasher.finish()
}

/// Engine-version prefix for every S3 object key. `hash_input`/`hash_payload`
/// key on inputs only, NOT the engine version or the serialized shape, so any
/// change to either MUST bump this prefix — results from an older engine are
/// then never served for identical inputs. Single-sourced here so all key
/// builders (`cache_key`, `link_estimate_key`, `link_estimate_alias_key`,
/// `simulate_key`, `sweep_marker_key`, and the `S3CacheRef` mirror) move
/// together on a bump.
///
/// Note the hashers are std `DefaultHasher` (not stable across Rust
/// toolchains): a toolchain change rotates the keyspace, causing a
/// miss-and-recompute — never a wrong-result. This matters most for the
/// forever-persisted `simulate-`/`link-estimate-` objects (no TTL to age out a
/// rotated key), but it is a recompute cost, not a correctness risk.
const CACHE_VERSION_PREFIX: &str = "shapley/v3";
const PUBLICATION_VERSION_PREFIX: &str = "publication/v1";

/// TCP connect timeout for every S3 client this service builds.
pub(crate) const S3_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Per-socket-read timeout. Bounds a body stream that stalls mid-transfer,
/// which no other timeout covers: a response body is read after the operation
/// itself has completed.
pub(crate) const S3_READ_TIMEOUT: Duration = Duration::from_secs(20);
/// Timeout for one attempt of a request, retried by the SDK.
pub(crate) const S3_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout for a whole request including its retries.
pub(crate) const S3_OPERATION_TIMEOUT: Duration = Duration::from_secs(90);

/// Timeouts for every S3 client in this service. The SDK default bounds the
/// connect phase alone, so a request over an established but blackholed
/// connection would otherwise never return, which stalls the diff poller's
/// loop for good, since one pass must finish before the next tick fires.
pub(crate) fn s3_timeout_config() -> TimeoutConfig {
    TimeoutConfig::builder()
        .connect_timeout(S3_CONNECT_TIMEOUT)
        .read_timeout(S3_READ_TIMEOUT)
        .operation_attempt_timeout(S3_ATTEMPT_TIMEOUT)
        .operation_timeout(S3_OPERATION_TIMEOUT)
        .build()
}

/// S3-backed cache for persisting per-city Shapley values across pod restarts.
#[derive(Clone)]
pub struct S3Cache {
    client: aws_sdk_s3::Client,
    bucket: String,
}

/// Where the result behind an alias currently lives. An `Unpersisted` result
/// is written to S3 before its alias, so an alias never points at nothing.
pub(crate) enum PublicationSource<'a> {
    /// Already read back from S3.
    Persisted(&'a crate::model::LinkEstimateResponse),
    /// Freshly solved, or recovered from the Redis result cache.
    Unpersisted(&'a crate::model::LinkEstimateResponse),
}

impl From<S3CacheRef> for S3Cache {
    fn from(cache: S3CacheRef) -> Self {
        Self {
            client: cache.client,
            bucket: cache.bucket,
        }
    }
}

impl S3Cache {
    /// Try to create an S3 cache client.
    ///
    /// Returns `None` if `S3_CACHE_BUCKET` is not set, which makes the
    /// cache layer a no-op in local development.
    ///
    /// Targets an **S3-compatible object store**, not necessarily AWS. When
    /// `S3_CACHE_ENDPOINT` is set (e.g. an in-cluster S3-compatible object
    /// gateway at `http://<gateway-host>:<port>`) the client uses that endpoint
    /// with **path-style** addressing — the gateway is reached by its Service
    /// hostname, so virtual-host `<bucket>.<host>` can't resolve. Credentials come
    /// from the standard `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env (the
    /// ObjectBucketClaim secret), read by the default chain — no STS, no AWS
    /// metadata, no internet egress. With no endpoint set it's a plain AWS-S3
    /// client (back-compat).
    pub async fn new() -> Option<Self> {
        let bucket = std::env::var("S3_CACHE_BUCKET").ok()?;
        let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_string());

        let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_sdk_s3::config::Region::new(region))
            .timeout_config(s3_timeout_config())
            .load()
            .await;

        let mut conf = aws_sdk_s3::config::Builder::from(&shared);
        if let Ok(endpoint) = std::env::var("S3_CACHE_ENDPOINT") {
            tracing::info!(%endpoint, "S3 cache using custom endpoint (path-style)");
            conf = conf.endpoint_url(endpoint).force_path_style(true);
        }
        let client = aws_sdk_s3::Client::from_conf(conf.build());

        tracing::info!(%bucket, "S3 cache enabled");
        Some(Self { client, bucket })
    }

    /// Derive the S3 object key for a given input hash.
    ///
    /// The version prefix exists because `hash_input` keys on inputs only, NOT
    /// the engine version or the cached shape — any change to either must bump
    /// the prefix so results computed by an older engine are never served as
    /// valid for identical inputs.
    fn cache_key(input_hash: u64) -> String {
        S3CacheRef::cache_key(input_hash)
    }

    /// Load a cached epoch from S3, if it exists and deserialises cleanly.
    pub async fn load(&self, input_hash: u64) -> Option<EpochCache> {
        let key = Self::cache_key(input_hash);
        tracing::info!(%key, "loading cache from S3");

        match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(resp) => {
                let bytes = resp.body.collect().await.ok()?.into_bytes();
                match bincode::deserialize::<EpochCache>(&bytes) {
                    Ok(cache) => {
                        tracing::info!(
                            cities = cache.per_city_values.len(),
                            has_baseline = cache.baseline_values.is_some(),
                            "loaded cache from S3"
                        );
                        Some(cache)
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "failed to deserialize S3 cache");
                        None
                    }
                }
            }
            Err(e) => {
                tracing::debug!(error = %e, "no cache found in S3 (expected on first run)");
                None
            }
        }
    }

    /// Persist a cache epoch to S3. Errors are logged but never fatal.
    pub async fn store(&self, cache: &EpochCache) {
        self.handle().store(cache).await;
    }

    /// Awaited persistence of a baseline, for callers that must know the result
    /// is durable before pointing an alias at it.
    pub(crate) async fn persist_baseline(&self, cache: &EpochCache) -> anyhow::Result<()> {
        self.handle().try_store(cache).await
    }

    // The fixed prefix keeps this key space apart from link-estimate aliases
    // built from the same tag; callers reject NUL in the tag.
    fn baseline_alias_key(tag: &str) -> String {
        let hash = crate::queue::hash_payload(&format!("baseline\u{0}{tag}"));
        format!(
            "{CACHE_VERSION_PREFIX}/{PUBLICATION_VERSION_PREFIX}/baseline-alias-{hash:016x}.json"
        )
    }

    /// Publish the baseline in `cache` under `tag`, after the result itself is
    /// durable. The cache object is always re-put: a memory hit does not prove
    /// the detached store ever landed.
    pub(crate) async fn publish_baseline(
        &self,
        tag: &str,
        variant: BaselineVariant,
        cache: &EpochCache,
    ) -> anyhow::Result<()> {
        use anyhow::Context;
        anyhow::ensure!(!tag.contains('\0'), "invalid alias key");
        let baseline = cache
            .baseline_values
            .as_ref()
            .context("epoch cache has no baseline")?;
        self.persist_baseline(cache).await?;
        let alias = BaselineAlias {
            tag: tag.to_owned(),
            variant,
            input_hash: format!("{:016x}", cache.input_hash),
            result: response_from_baseline(baseline),
        };
        self.store_baseline_alias(&alias).await
    }

    async fn store_baseline_alias(&self, alias: &BaselineAlias) -> anyhow::Result<()> {
        use anyhow::Context;
        let body = serde_json::to_vec(alias).context("serialize baseline alias")?;
        let key = Self::baseline_alias_key(&alias.tag);
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .content_type("application/json")
            .body(body.into())
            .send()
            .await
            .context("persist baseline alias")?;
        tracing::info!(%key, tag = %alias.tag, variant = %alias.variant, "stored baseline alias");
        Ok(())
    }

    /// The published baseline for `tag`. `Ok(None)` is an ordinary miss. A
    /// storage failure is an error, because the probe route must tell "not
    /// cached" from "store down".
    pub async fn load_baseline_alias(
        &self,
        tag: &str,
    ) -> Result<Option<BaselineAlias>, BaselineAliasError> {
        let key = Self::baseline_alias_key(tag);
        let response = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) if e.as_service_error().is_some_and(|se| se.is_no_such_key()) => {
                tracing::debug!(%key, "no baseline alias in S3");
                return Ok(None);
            }
            Err(e) => {
                return Err(BaselineAliasError::Storage {
                    detail: format!("{e:?}"),
                });
            }
        };
        let bytes = response
            .body
            .collect()
            .await
            .map_err(|e| BaselineAliasError::Storage {
                detail: format!("{e:?}"),
            })?
            .into_bytes();
        let alias: BaselineAlias =
            serde_json::from_slice(&bytes).map_err(|e| BaselineAliasError::Malformed {
                detail: format!("{key}: {e}"),
            })?;
        if alias.tag != tag {
            return Err(BaselineAliasError::Malformed {
                detail: format!("{key}: stored tag {:?} differs from request", alias.tag),
            });
        }
        Ok(Some(alias))
    }

    /// Clone of the client and bucket as a `Send + 'static` handle, so other
    /// S3-backed stores can share the configured connection.
    pub fn handle(&self) -> S3CacheRef {
        S3CacheRef {
            client: self.client.clone(),
            bucket: self.bucket.clone(),
        }
    }

    /// Borrow the bucket name for spawned tasks.
    pub fn bucket_name(&self) -> &str {
        &self.bucket
    }

    /// Clone-friendly reference to the underlying S3 client.
    pub fn client_ref(&self) -> &aws_sdk_s3::Client {
        &self.client
    }

    /// Derive the S3 object key for a cached link-estimate result.
    ///
    /// Keyed by the JOB PAYLOAD hash — `queue::hash_payload` over the serialized
    /// `LinkEstimateRequest` (input + operator_focus together), i.e. the same
    /// value as a stream entry's `input_hash` — NOT `hash_input` (topology
    /// only). Distinct `link-estimate-` prefix so it can never collide with the
    /// baseline `cache-` keys. Epoch inputs are immutable, so entries are
    /// valid forever; the `v3` engine-version prefix still applies.
    fn link_estimate_key(payload_hash: u64) -> String {
        format!("{CACHE_VERSION_PREFIX}/link-estimate-{payload_hash:016x}.bin")
    }

    /// Load a cached link-estimate result from S3, if present and clean.
    pub async fn load_link_estimate(
        &self,
        payload_hash: u64,
    ) -> Option<crate::model::LinkEstimateResponse> {
        let key = Self::link_estimate_key(payload_hash);
        match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(resp) => {
                let bytes = resp.body.collect().await.ok()?.into_bytes();
                match bincode::deserialize::<crate::model::LinkEstimateResponse>(&bytes) {
                    Ok(cached) => {
                        tracing::info!(%key, links = cached.links.len(),
                            "loaded link-estimate from S3");
                        Some(cached)
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, %key,
                            "failed to deserialize S3 link-estimate — treating as miss");
                        None
                    }
                }
            }
            Err(e) => {
                tracing::debug!(error = %e, %key, "no link-estimate in S3");
                None
            }
        }
    }

    /// Best-effort background persistence of a finished link estimate. A
    /// failure is logged and never fails the compute that produced it.
    pub fn store_link_estimate(
        &self,
        payload_hash: u64,
        resp: &crate::model::LinkEstimateResponse,
    ) {
        let bytes = match bincode::serialize(resp) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::error!(%error, "failed to serialize link estimate");
                return;
            }
        };
        let cache = self.clone();
        tokio::spawn(async move {
            if let Err(error) = cache.put_link_estimate_bytes(payload_hash, bytes).await {
                tracing::error!(%error, "failed to persist link estimate");
            }
        });
    }

    /// Awaited persistence of a finished link estimate, for callers that must
    /// know the result is durable before pointing an alias at it.
    pub(crate) async fn persist_link_estimate(
        &self,
        payload_hash: u64,
        resp: &crate::model::LinkEstimateResponse,
    ) -> anyhow::Result<()> {
        use anyhow::Context;
        let bytes = bincode::serialize(resp).context("serialize link estimate")?;
        self.put_link_estimate_bytes(payload_hash, bytes).await
    }

    async fn put_link_estimate_bytes(
        &self,
        payload_hash: u64,
        bytes: Vec<u8>,
    ) -> anyhow::Result<()> {
        use anyhow::Context;
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(Self::link_estimate_key(payload_hash))
            .body(bytes.into())
            .send()
            .await
            .context("persist link estimate result")?;
        Ok(())
    }

    /// Publishes only after the referenced result is durable.
    pub(crate) async fn publish_link_estimate(
        &self,
        tag: &str,
        focus: &str,
        payload_hash: u64,
        source: PublicationSource<'_>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !tag.contains('\0') && !focus.contains('\0'),
            "invalid alias key"
        );
        let (result, is_persisted) = match source {
            PublicationSource::Persisted(result) => (result, true),
            PublicationSource::Unpersisted(result) => (result, false),
        };
        anyhow::ensure!(
            result.operator_focus == focus,
            "cached result has a different operator focus"
        );
        if !is_persisted {
            self.persist_link_estimate(payload_hash, result).await?;
        }
        self.store_link_estimate_alias(tag, focus, payload_hash)
            .await
    }

    // NUL separates tag and focus; callers reject NUL in either value.
    fn link_estimate_alias_key(tag: &str, focus: &str) -> String {
        let hash = crate::queue::hash_payload(&format!("{tag}\u{0}{focus}"));
        format!(
            "{CACHE_VERSION_PREFIX}/{PUBLICATION_VERSION_PREFIX}/link-estimate-alias-{hash:016x}.json"
        )
    }

    async fn store_link_estimate_alias(
        &self,
        tag: &str,
        focus: &str,
        payload_hash: u64,
    ) -> anyhow::Result<()> {
        use anyhow::Context;
        let body = serde_json::json!({ "payloadHash": format!("{payload_hash:016x}") }).to_string();
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(Self::link_estimate_alias_key(tag, focus))
            .content_type("application/json")
            .body(body.into_bytes().into())
            .send()
            .await
            .context("persist link estimate alias")?;
        Ok(())
    }

    /// The payload hash recorded for `(tag, focus)`, if any. A missing or
    /// malformed object reads as `None`, which sends the caller down the
    /// rebuild-from-snapshot path rather than failing. A storage failure also
    /// reads as `None`, but logs at `warn` so an outage on this path does not
    /// look like an ordinary miss.
    pub async fn load_link_estimate_alias(&self, tag: &str, focus: &str) -> Option<u64> {
        let key = Self::link_estimate_alias_key(tag, focus);
        let response = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) if e.as_service_error().is_some_and(|se| se.is_no_such_key()) => {
                tracing::debug!(%key, "no link-estimate alias in S3");
                return None;
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    %key,
                    "link-estimate alias read failed; treating as a miss"
                );
                return None;
            }
        };
        let bytes = response.body.collect().await.ok()?.into_bytes();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes)
            .inspect_err(|e| tracing::warn!(error = %e, %key, "link-estimate alias is not JSON"))
            .ok()?;
        let hex = parsed.get("payloadHash").and_then(|v| v.as_str())?;
        u64::from_str_radix(hex, 16)
            .inspect_err(
                |e| tracing::warn!(error = %e, %key, hex, "link-estimate alias hash is not hex"),
            )
            .ok()
    }

    /// Derive the S3 object key for a cached simulate (what-if) result.
    ///
    /// Keyed by the WHOLE `SimulateRequest` payload hash (`queue::hash_payload`,
    /// identical to the stream entry's `input_hash`) — baseline AND modified
    /// together determine the result. Distinct `simulate-` prefix so it can
    /// never collide with the baseline `cache-` or `link-estimate-` keys;
    /// `.json` (not bincode) because the simulate pipeline is kind-agnostic
    /// `serde_json::Value` and bincode cannot round-trip `Value`. Epoch inputs
    /// are immutable, so entries persist forever; the [`CACHE_VERSION_PREFIX`]
    /// engine-version prefix is the sole staleness guard.
    fn simulate_key(payload_hash: u64) -> String {
        format!("{CACHE_VERSION_PREFIX}/simulate-{payload_hash:016x}.json")
    }

    /// Load a cached simulate result from S3, if present and well-formed.
    ///
    /// Validates the object deserializes as a [`crate::model::SimulateResponse`]
    /// and treats any mismatch (wrong shape, partial/corrupt JSON) as a miss so
    /// the job recomputes rather than republishing garbage to the client. On a
    /// hit it returns the untyped `Value` parsed from the SAME bytes — never a
    /// re-serialized typed struct — so a submit-time S3 hit republishes
    /// byte-identically to a Redis `result:{hash}` cache hit (both re-emit via
    /// `set_done` → `Value::to_string`).
    pub async fn load_simulate(&self, payload_hash: u64) -> Option<serde_json::Value> {
        let key = Self::simulate_key(payload_hash);
        match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(resp) => {
                let bytes = resp.body.collect().await.ok()?.into_bytes();
                // Shape gate: a valid SimulateResponse implies valid JSON, so the
                // Value parse below then always succeeds — but keep both parses
                // explicit so a shape mismatch and a raw-JSON error log distinctly.
                if let Err(e) = serde_json::from_slice::<crate::model::SimulateResponse>(&bytes) {
                    tracing::warn!(error = %e, %key,
                        "S3 simulate object is not a valid SimulateResponse — treating as miss");
                    return None;
                }
                match serde_json::from_slice::<serde_json::Value>(&bytes) {
                    Ok(cached) => {
                        tracing::info!(%key, "loaded simulate from S3");
                        Some(cached)
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, %key,
                            "failed to parse S3 simulate as JSON — treating as miss");
                        None
                    }
                }
            }
            Err(e) => {
                // Distinguish the expected miss (NoSuchKey) from a real S3 fault
                // (transport/auth/config) — an operator debugging a stuck
                // share-link job needs to tell "not cached yet" from "S3 down".
                if e.as_service_error().is_some_and(|se| se.is_no_such_key()) {
                    tracing::debug!(%key, "no simulate in S3 (miss)");
                } else {
                    tracing::warn!(error = %e, %key, "S3 get_object failed for simulate");
                }
                None
            }
        }
    }

    /// Persist a simulate result to S3 in the background. Best-effort: failures
    /// are logged loudly but never fail the compute that produced the result
    /// (the Redis result cache still covers the next hour either way). The JSON
    /// bytes match the Redis result-cache representation exactly, so an S3 hit
    /// at submit and a Redis hit at pickup republish a byte-identical response.
    pub fn store_simulate(&self, payload_hash: u64, resp: &serde_json::Value) {
        let key = Self::simulate_key(payload_hash);
        let bytes = resp.to_string().into_bytes();
        let client = self.client.clone();
        let bucket = self.bucket.clone();
        tokio::spawn(async move {
            let size = bytes.len();
            match client
                .put_object()
                .bucket(&bucket)
                .key(&key)
                .body(bytes.into())
                .send()
                .await
            {
                Ok(_) => {
                    tracing::info!(%key, size_bytes = size, "stored simulate to S3")
                }
                Err(e) => {
                    tracing::error!(error = %e, %key, "failed to store simulate to S3")
                }
            }
        });
    }

    /// Derive the S3 object key for an epoch-sweep completion marker.
    ///
    /// The tag is opaque caller input (e.g. `epoch-149:canonical-v1:{fp}`), so
    /// it is hashed — same `queue::hash_payload` discipline as every other
    /// cache key — rather than interpolated into the key raw. The raw tag is
    /// stored INSIDE the marker object for debuggability.
    fn sweep_marker_key(tag: &str) -> String {
        let hash = crate::queue::hash_payload(tag);
        format!("{CACHE_VERSION_PREFIX}/{PUBLICATION_VERSION_PREFIX}/sweep-marker-{hash:016x}.json")
    }

    /// Whether the "fully swept" marker exists for this tag (epoch inputs are
    /// immutable, so a marker can never go stale; params/builder changes rotate
    /// the tag via its fingerprint and naturally miss).
    pub async fn load_sweep_marker(&self, tag: &str) -> bool {
        let key = Self::sweep_marker_key(tag);
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(_) => {
                tracing::info!(%key, tag, "sweep marker present");
                true
            }
            Err(e) => {
                tracing::debug!(error = %e, %key, tag, "no sweep marker");
                false
            }
        }
    }

    /// Write the "fully swept" marker for this tag. Awaited (not spawned):
    /// the sweep job's summary reports `marker_written` only when the PUT
    /// landed. Best-effort beyond that — a failure just means the next cron
    /// fire pays one more full build before retrying the marker.
    pub async fn store_sweep_marker(&self, tag: &str) -> bool {
        let key = Self::sweep_marker_key(tag);
        let body = serde_json::json!({ "tag": tag }).to_string();
        match self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .body(body.into_bytes().into())
            .send()
            .await
        {
            Ok(_) => {
                tracing::info!(%key, tag, "stored sweep marker to S3");
                true
            }
            Err(e) => {
                tracing::error!(error = %e, %key, tag, "failed to store sweep marker");
                false
            }
        }
    }
}

/// Lightweight, `Send + 'static` handle used inside `tokio::spawn` for
/// background S3 persistence.  Avoids needing `Arc<S3Cache>`.
pub struct S3CacheRef {
    pub client: aws_sdk_s3::Client,
    pub bucket: String,
}

impl S3CacheRef {
    /// The one builder for the baseline result key (per-city layout +
    /// linear-uptime engine under [`CACHE_VERSION_PREFIX`]).
    fn cache_key(input_hash: u64) -> String {
        format!("{CACHE_VERSION_PREFIX}/cache-{input_hash:016x}.bin")
    }

    /// Persist an epoch cache and report the failure to the caller.
    pub(crate) async fn try_store(&self, cache: &EpochCache) -> anyhow::Result<()> {
        use anyhow::Context;
        let key = Self::cache_key(cache.input_hash);
        let bytes = bincode::serialize(cache).context("serialise cache")?;
        let size = bytes.len();
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .body(bytes.into())
            .send()
            .await
            .context("store cache to S3")?;
        tracing::info!(%key, size_bytes = size, "stored cache to S3");
        Ok(())
    }

    /// Best-effort persistence; logs and never fails the compute that produced it.
    pub async fn store(&self, cache: &EpochCache) {
        if let Err(error) = self.try_store(cache).await {
            tracing::error!(%error, "failed to store cache to S3");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_metadata_uses_a_new_namespace_without_rotating_results() {
        assert_eq!(
            S3Cache::link_estimate_key(42),
            "shapley/v3/link-estimate-000000000000002a.bin"
        );
        assert!(
            S3Cache::link_estimate_alias_key("tag", "focus")
                .starts_with("shapley/v3/publication/v1/")
        );
        assert!(S3Cache::sweep_marker_key("tag").starts_with("shapley/v3/publication/v1/"));
    }

    #[test]
    fn simulate_key_is_zero_padded_hex_under_v3_json() {
        assert_eq!(
            S3Cache::simulate_key(0xdead_beef),
            "shapley/v3/simulate-00000000deadbeef.json"
        );
    }

    #[test]
    fn s3_timeout_config_bounds_reads_and_whole_operations() {
        let config = s3_timeout_config();
        assert_eq!(config.connect_timeout(), Some(S3_CONNECT_TIMEOUT));
        assert_eq!(config.read_timeout(), Some(S3_READ_TIMEOUT));
        assert_eq!(config.operation_attempt_timeout(), Some(S3_ATTEMPT_TIMEOUT));
        assert_eq!(config.operation_timeout(), Some(S3_OPERATION_TIMEOUT));
        assert!(S3_ATTEMPT_TIMEOUT <= S3_OPERATION_TIMEOUT);
    }
}

#[cfg(test)]
mod alias_tests {
    use super::*;

    #[test]
    fn alias_key_is_stable_and_separates_its_two_parts() {
        let key = S3Cache::link_estimate_alias_key("epoch-211:canonical-v1:9f2c", "tsw");
        assert_eq!(
            key,
            S3Cache::link_estimate_alias_key("epoch-211:canonical-v1:9f2c", "tsw"),
            "same pair, same key"
        );
        assert!(key.starts_with(CACHE_VERSION_PREFIX));
        assert!(key.contains("link-estimate-alias-"));
    }

    #[test]
    fn alias_key_changes_when_either_part_changes() {
        let base = S3Cache::link_estimate_alias_key("epoch-211:v1:aa", "tsw");
        assert_ne!(
            base,
            S3Cache::link_estimate_alias_key("epoch-211:v1:aa", "xyz")
        );
        assert_ne!(
            base,
            S3Cache::link_estimate_alias_key("epoch-212:v1:aa", "tsw")
        );
        // The fingerprint is the guard against a parameter flip resolving to a
        // pre-flip result, so it must reach the key.
        assert_ne!(
            base,
            S3Cache::link_estimate_alias_key("epoch-211:v1:bb", "tsw")
        );
    }

    #[test]
    fn a_nul_separator_stops_the_two_parts_from_running_together() {
        // With a ":" separator these two would hash the same string.
        assert_ne!(
            S3Cache::link_estimate_alias_key("epoch-1:v", "a"),
            S3Cache::link_estimate_alias_key("epoch-1", "v:a")
        );
    }

    #[test]
    fn alias_keys_cannot_collide_with_the_result_keys_they_point_at() {
        let alias = S3Cache::link_estimate_alias_key("epoch-211:v1", "tsw");
        for hash in [0u64, 1, u64::MAX, 0x9f2c_1234_5678_90ab] {
            assert_ne!(alias, S3Cache::link_estimate_key(hash));
            assert_ne!(alias, S3Cache::simulate_key(hash));
            assert_ne!(alias, S3Cache::cache_key(hash));
        }
    }
}

#[cfg(test)]
mod baseline_alias_tests {
    use super::*;

    #[test]
    fn baseline_alias_key_is_under_the_publication_prefix() {
        let key = S3Cache::baseline_alias_key("baseline:epoch-211:canonical-v1:9f2c");
        assert!(key.starts_with("shapley/v3/publication/v1/baseline-alias-"));
        assert!(key.ends_with(".json"));
    }

    #[test]
    fn baseline_alias_key_differs_from_the_link_estimate_alias_of_the_same_tag() {
        let tag = "epoch-211:canonical-v1:9f2c";
        assert_ne!(
            S3Cache::baseline_alias_key(tag),
            S3Cache::link_estimate_alias_key(tag, "")
        );
        assert_ne!(
            S3Cache::baseline_alias_key(tag),
            S3Cache::sweep_marker_key(tag)
        );
        assert_ne!(
            S3Cache::baseline_alias_key("epoch-210:v1:a"),
            S3Cache::baseline_alias_key("epoch-211:v1:a")
        );
    }

    #[test]
    fn baseline_alias_error_detail_stays_out_of_display() {
        let error = BaselineAliasError::Storage {
            detail: "http://gateway.internal:7480 refused".into(),
        };
        assert_eq!(error.to_string(), "baseline store unavailable");
        let error = BaselineAliasError::Malformed {
            detail: "key: stored tag differs".into(),
        };
        assert_eq!(error.to_string(), "baseline alias is malformed");
    }
}
