//! Epoch-level per-city Shapley value cache with S3 persistence.
//!
//! Caches each source city's per-operator Shapley values so that repeated
//! computations (e.g., what-if simulations adding/removing links) can reuse
//! the cities they didn't change instead of re-solving every per-city LP.

use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};

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

/// S3-backed cache for persisting per-city Shapley values across pod restarts.
pub struct S3Cache {
    client: aws_sdk_s3::Client,
    bucket: String,
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
        format!("shapley/v3/cache-{:016x}.bin", input_hash)
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
        S3CacheRef {
            client: self.client.clone(),
            bucket: self.bucket.clone(),
        }
        .store(cache)
        .await;
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
        format!("shapley/v3/link-estimate-{payload_hash:016x}.bin")
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

    /// Persist a link-estimate result to S3 in the background. Best-effort:
    /// failures are logged loudly but never fail the compute that produced the
    /// result (the Redis result cache still covers the next hour either way).
    pub fn store_link_estimate(
        &self,
        payload_hash: u64,
        resp: &crate::model::LinkEstimateResponse,
    ) {
        let key = Self::link_estimate_key(payload_hash);
        let bytes = match bincode::serialize(resp) {
            Ok(b) => b,
            Err(e) => {
                tracing::error!(error = %e, "failed to serialise link-estimate");
                return;
            }
        };
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
                    tracing::info!(%key, size_bytes = size, "stored link-estimate to S3")
                }
                Err(e) => {
                    tracing::error!(error = %e, %key, "failed to store link-estimate to S3")
                }
            }
        });
    }

    /// Derive the S3 object key for a cached simulate (what-if) result.
    ///
    /// Keyed by the WHOLE `SimulateRequest` payload hash (`queue::hash_payload`,
    /// identical to the stream entry's `input_hash`) — baseline AND modified
    /// together determine the result. Distinct `simulate-` prefix so it can
    /// never collide with the baseline `cache-` or `link-estimate-` keys;
    /// `.json` (not bincode) because the simulate pipeline is kind-agnostic
    /// `serde_json::Value` and bincode cannot round-trip `Value`. Epoch inputs
    /// are immutable, so entries are valid forever; the `v3` engine-version
    /// prefix still applies.
    fn simulate_key(payload_hash: u64) -> String {
        format!("shapley/v3/simulate-{payload_hash:016x}.json")
    }

    /// Load a cached simulate result from S3, if present and it parses as JSON.
    /// A corrupt object is logged and treated as a miss (recompute) — same
    /// posture as `jobs::RedisJobStore::result_cache_get`.
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
                match serde_json::from_slice::<serde_json::Value>(&bytes) {
                    Ok(cached) => {
                        tracing::info!(%key, "loaded simulate from S3");
                        Some(cached)
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, %key,
                            "failed to deserialize S3 simulate — treating as miss");
                        None
                    }
                }
            }
            Err(e) => {
                tracing::debug!(error = %e, %key, "no simulate in S3");
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
        format!("shapley/v3/sweep-marker-{hash:016x}.json")
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
    // Keep in lockstep with `S3Cache::cache_key` (v3 prefix; per-city layout +
    // linear-uptime engine).
    fn cache_key(input_hash: u64) -> String {
        format!("shapley/v3/cache-{input_hash:016x}.bin")
    }

    pub async fn store(&self, cache: &EpochCache) {
        let key = Self::cache_key(cache.input_hash);
        let bytes = match bincode::serialize(cache) {
            Ok(b) => b,
            Err(e) => {
                tracing::error!(error = %e, "failed to serialise cache");
                return;
            }
        };

        let size = bytes.len();
        match self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .body(bytes.into())
            .send()
            .await
        {
            Ok(_) => tracing::info!(%key, size_bytes = size, "stored cache to S3"),
            Err(e) => tracing::error!(error = %e, "failed to store cache to S3"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::S3Cache;

    #[test]
    fn simulate_key_is_zero_padded_hex_under_v3_json() {
        assert_eq!(
            S3Cache::simulate_key(0xdead_beef),
            "shapley/v3/simulate-00000000deadbeef.json"
        );
    }
}
