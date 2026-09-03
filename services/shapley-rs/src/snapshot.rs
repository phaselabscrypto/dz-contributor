//! Public snapshot bucket access and the streaming section scanner.
//!
//! Reads the first few megabytes of a DoubleZero epoch snapshot from the
//! public S3 bucket and captures the four `dz_serviceability` sections the
//! diff index needs. Nothing here depends on `AppState`.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use aws_sdk_s3::error::{DisplayErrorContext, SdkError};
use aws_sdk_s3::primitives::ByteStream;
use serde::{Deserialize, Serialize};

/// Boxed, sendable future returned by the trait methods in this crate.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A DoubleZero epoch number. Newtype so an epoch is never confused with a
/// byte count or a depth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Epoch(pub u32);

impl fmt::Display for Epoch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Public bucket that holds one immutable snapshot per epoch.
pub const DEFAULT_SNAPSHOT_BUCKET: &str = "doublezero-contributor-rewards-mn-beta-snapshots";
/// Region of [`DEFAULT_SNAPSHOT_BUCKET`].
pub const DEFAULT_SNAPSHOT_REGION: &str = "us-east-1";
/// Earliest published snapshot.
pub const MIN_DZ_EPOCH: Epoch = Epoch(48);
/// dz_telemetry began at 9.7 MB on epoch 211; 3x headroom, still forbids the 110 MB read.
pub const MAX_SCAN_BYTES: usize = 32 * 1024 * 1024;
/// Upper bound on one snapshot fetch, from request start to the last scanned byte.
pub(crate) const SNAPSHOT_FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// The `dz_serviceability` children the diff index reads, in file order.
pub(crate) const DIFF_SECTION_KEYS: [&str; 4] = ["locations", "devices", "links", "contributors"];

const DISCOVERY_PROBE_START: u32 = 100;
const DISCOVERY_PROBE_CAP: u32 = 10_000;
const FETCH_DATA_KEY: &str = "fetch_data";
const SERVICEABILITY_KEY: &str = "dz_serviceability";
const EPOCH_KEY: &str = "dz_epoch";
/// Keys are decoded only at the root, under `fetch_data`, and under `dz_serviceability`.
const KEY_CAPTURE_MAX_DEPTH: usize = 3;

/// Why a scan over snapshot bytes produced no result.
#[non_exhaustive]
#[derive(Debug, PartialEq, Eq)]
pub enum ScanFailure {
    /// The stream ended before every wanted section was captured.
    Truncated,
    /// More than [`MAX_SCAN_BYTES`] arrived without the scan completing.
    BudgetExceeded,
    /// `dz_serviceability` closed without this wanted key.
    MissingSection(&'static str),
    /// `dz_epoch` was absent or not an unsigned integer.
    MissingEpoch,
    /// `dz_epoch` names a different epoch than the one requested.
    EpochMismatch {
        /// The epoch the snapshot carries.
        found: Epoch,
    },
    /// A wanted key holds something other than a JSON object.
    SectionNotObject(&'static str),
    /// The bytes are not well-formed for the shape the scanner expects.
    Malformed(String),
}

impl fmt::Display for ScanFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => write!(f, "stream ended before every wanted section was captured"),
            Self::BudgetExceeded => write!(f, "scan budget of {MAX_SCAN_BYTES} bytes exceeded"),
            Self::MissingSection(key) => {
                write!(f, "section {key} not found under {SERVICEABILITY_KEY}")
            }
            Self::MissingEpoch => write!(f, "{EPOCH_KEY} not found or not an integer"),
            Self::EpochMismatch { found } => write!(f, "snapshot carries {EPOCH_KEY} {found}"),
            Self::SectionNotObject(key) => write!(f, "section {key} is not a JSON object"),
            Self::Malformed(message) => write!(f, "malformed snapshot: {message}"),
        }
    }
}

impl std::error::Error for ScanFailure {}

/// Failure to fetch or scan one epoch's snapshot.
#[non_exhaustive]
#[derive(Debug)]
pub enum SnapshotError {
    /// The bucket has no object for this epoch.
    NotFound {
        /// Requested epoch.
        epoch: Epoch,
    },
    /// The bucket answered with a non-success status other than 404.
    Http {
        /// Requested epoch.
        epoch: Epoch,
        /// HTTP status the bucket returned.
        status: u16,
    },
    /// The request never completed at the transport level.
    Transport {
        /// Requested epoch.
        epoch: Epoch,
        /// Transport error text, for logs only.
        message: String,
    },
    /// The bytes arrived but the scanner rejected them.
    Scan {
        /// Requested epoch.
        epoch: Epoch,
        /// Bytes consumed before the failure.
        bytes_read: usize,
        /// The scanner's reason.
        failure: ScanFailure,
    },
    /// [`SNAPSHOT_FETCH_TIMEOUT`] elapsed.
    Timeout {
        /// Requested epoch.
        epoch: Epoch,
    },
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { epoch } => write!(f, "epoch {epoch}: snapshot HTTP 404"),
            Self::Http { epoch, status } => write!(f, "epoch {epoch}: snapshot HTTP {status}"),
            Self::Transport { epoch, message } => {
                write!(f, "epoch {epoch}: snapshot transport error: {message}")
            }
            Self::Scan {
                epoch,
                bytes_read,
                failure,
            } => write!(
                f,
                "epoch {epoch}: snapshot scan failed after {bytes_read} bytes: {failure}"
            ),
            Self::Timeout { epoch } => write!(
                f,
                "epoch {epoch}: snapshot fetch timed out after {}s",
                SNAPSHOT_FETCH_TIMEOUT.as_secs()
            ),
        }
    }
}

impl std::error::Error for SnapshotError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Scan { failure, .. } => Some(failure),
            _ => None,
        }
    }
}

/// The captured sections of one snapshot.
#[must_use]
#[derive(Debug)]
pub struct ScanResult {
    /// Epoch the snapshot carries; equals the requested epoch.
    pub epoch: Epoch,
    /// Raw JSON object bytes per key in [`DIFF_SECTION_KEYS`].
    pub sections: HashMap<&'static str, Vec<u8>>,
    /// Bytes consumed from the stream.
    pub bytes_read: usize,
    /// Whether the scan stopped before the stream ended.
    pub is_cancelled_early: bool,
}

/// Where scanned snapshot sections come from. The S3 implementation streams
/// the public bucket; tests implement it over synthetic bytes.
pub trait SnapshotReader: Send + Sync {
    /// Stream the snapshot for `epoch` and capture its wanted sections.
    fn fetch_sections(&self, epoch: Epoch) -> BoxFuture<'_, Result<ScanResult, SnapshotError>>;
    /// Whether a snapshot exists for `epoch`.
    fn has_snapshot(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, SnapshotError>>;
}

/// Unsigned S3 client for the public bucket. Env overrides:
/// `DZ_SNAPSHOT_BUCKET`, `DZ_SNAPSHOT_REGION`.
pub struct S3SnapshotReader {
    client: aws_sdk_s3::Client,
    bucket: String,
}

impl S3SnapshotReader {
    /// Build the reader from the environment, falling back to the public
    /// bucket defaults. Anonymous: no credentials are looked up.
    pub async fn from_env() -> Self {
        let bucket = std::env::var("DZ_SNAPSHOT_BUCKET")
            .unwrap_or_else(|_| DEFAULT_SNAPSHOT_BUCKET.to_string());
        let region = std::env::var("DZ_SNAPSHOT_REGION")
            .unwrap_or_else(|_| DEFAULT_SNAPSHOT_REGION.to_string());
        let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .no_credentials()
            .region(aws_sdk_s3::config::Region::new(region))
            .timeout_config(crate::cache::s3_timeout_config())
            .load()
            .await;
        tracing::info!(%bucket, "snapshot reader enabled (unsigned)");
        Self {
            client: aws_sdk_s3::Client::new(&shared),
            bucket,
        }
    }

    /// Object key of one epoch's snapshot.
    pub(crate) fn object_key(epoch: Epoch) -> String {
        format!("mn-epoch-{}-snapshot.json", epoch.0)
    }

    /// Bucket this reader targets.
    pub fn bucket_name(&self) -> &str {
        &self.bucket
    }

    async fn scan_object(&self, epoch: Epoch) -> Result<ScanResult, SnapshotError> {
        let started = Instant::now();
        let response = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(Self::object_key(epoch))
            .send()
            .await
            .map_err(|error| {
                map_sdk_error(epoch, error, |service_error| service_error.is_no_such_key())
            })?;
        let result = scan_stream(epoch, response.body).await?;
        tracing::info!(
            epoch = epoch.0,
            bytes_read = result.bytes_read,
            ms = started.elapsed().as_millis(),
            "snapshot sections fetched"
        );
        Ok(result)
    }
}

impl SnapshotReader for S3SnapshotReader {
    fn fetch_sections(&self, epoch: Epoch) -> BoxFuture<'_, Result<ScanResult, SnapshotError>> {
        Box::pin(async move {
            match tokio::time::timeout(SNAPSHOT_FETCH_TIMEOUT, self.scan_object(epoch)).await {
                Ok(result) => result,
                Err(_) => Err(SnapshotError::Timeout { epoch }),
            }
        })
    }

    fn has_snapshot(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, SnapshotError>> {
        Box::pin(async move {
            let head = self
                .client
                .head_object()
                .bucket(&self.bucket)
                .key(Self::object_key(epoch))
                .send()
                .await;
            match head {
                Ok(_) => Ok(true),
                Err(error) => {
                    match map_sdk_error(epoch, error, |service_error| service_error.is_not_found())
                    {
                        SnapshotError::NotFound { .. } => Ok(false),
                        other => Err(other),
                    }
                }
            }
        })
    }
}

/// Feed a body stream to a [`SectionScanner`] and drop the stream as soon as
/// the scan completes, which closes the connection.
pub(crate) async fn scan_stream(
    epoch: Epoch,
    mut body: ByteStream,
) -> Result<ScanResult, SnapshotError> {
    let mut scanner = SectionScanner::new(epoch);
    let mut has_stream_ended = true;
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|error| SnapshotError::Transport {
            epoch,
            message: error.to_string(),
        })?;
        let is_complete = scanner
            .push(&chunk)
            .map_err(|failure| SnapshotError::Scan {
                epoch,
                bytes_read: scanner.bytes_read(),
                failure,
            })?;
        if is_complete {
            has_stream_ended = false;
            break;
        }
    }
    drop(body);
    let bytes_read = scanner.bytes_read();
    scanner
        .finish(has_stream_ended)
        .map_err(|failure| SnapshotError::Scan {
            epoch,
            bytes_read,
            failure,
        })
}

fn map_sdk_error<E>(
    epoch: Epoch,
    error: SdkError<E>,
    is_not_found: impl FnOnce(&E) -> bool,
) -> SnapshotError
where
    E: std::error::Error + 'static,
{
    match &error {
        SdkError::ServiceError(context) => {
            if is_not_found(context.err()) {
                SnapshotError::NotFound { epoch }
            } else {
                SnapshotError::Http {
                    epoch,
                    status: context.raw().status().as_u16(),
                }
            }
        }
        SdkError::ResponseError(context) => SnapshotError::Http {
            epoch,
            status: context.raw().status().as_u16(),
        },
        _ => SnapshotError::Transport {
            epoch,
            message: DisplayErrorContext(&error).to_string(),
        },
    }
}

/// Highest published epoch: exponential probe from 100 (cap 10 000), then
/// binary search between the last hit and the first miss.
pub(crate) async fn discover_latest(reader: &dyn SnapshotReader) -> Result<Epoch, SnapshotError> {
    let mut last_ok = MIN_DZ_EPOCH.0;
    let mut probe = DISCOVERY_PROBE_START;
    while probe <= DISCOVERY_PROBE_CAP {
        if reader.has_snapshot(Epoch(probe)).await? {
            last_ok = probe;
            probe *= 2;
        } else {
            break;
        }
    }
    let mut low = last_ok;
    let mut high = probe;
    let mut latest = last_ok;
    while low <= high {
        let mid = low + (high - low) / 2;
        if reader.has_snapshot(Epoch(mid)).await? {
            latest = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    Ok(Epoch(latest))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameKind {
    Object,
    Array,
}

#[derive(Debug)]
struct Frame {
    kind: FrameKind,
    is_expecting_key: bool,
}

#[derive(Debug)]
struct Capture {
    key: &'static str,
    buf: Vec<u8>,
    close_depth: usize,
}

/// Pure incremental scanner over raw snapshot bytes. `push` returns
/// `Ok(true)` once all wanted sections are captured or `dz_serviceability`
/// closed. Depth is tracked on raw bytes: every structural JSON byte is
/// ASCII and UTF-8 continuation bytes are all `>= 0x80`.
#[derive(Debug)]
pub struct SectionScanner {
    expected_epoch: Epoch,
    stack: Vec<Frame>,
    is_in_string: bool,
    is_escaped: bool,
    is_capturing_key: bool,
    key_bytes: Vec<u8>,
    pending_key: Option<String>,
    is_after_colon: bool,
    fetch_data_depth: Option<usize>,
    serviceability_depth: Option<usize>,
    epoch_digits: Option<Vec<u8>>,
    capture: Option<Capture>,
    sections: HashMap<&'static str, Vec<u8>>,
    epoch: Option<Epoch>,
    bytes_read: usize,
    is_done: bool,
}

impl SectionScanner {
    /// A scanner that accepts only a snapshot carrying `expected_epoch`.
    pub fn new(expected_epoch: Epoch) -> Self {
        Self {
            expected_epoch,
            stack: Vec::new(),
            is_in_string: false,
            is_escaped: false,
            is_capturing_key: false,
            key_bytes: Vec::new(),
            pending_key: None,
            is_after_colon: false,
            fetch_data_depth: None,
            serviceability_depth: None,
            epoch_digits: None,
            capture: None,
            sections: HashMap::new(),
            epoch: None,
            bytes_read: 0,
            is_done: false,
        }
    }

    /// Bytes consumed so far.
    pub fn bytes_read(&self) -> usize {
        self.bytes_read
    }

    /// Whether the scan has completed and further chunks are ignored.
    pub fn is_done(&self) -> bool {
        self.is_done
    }

    /// Consume one chunk. Chunk boundaries may fall anywhere, including
    /// inside a string, an escape, a key, or a multibyte character.
    pub fn push(&mut self, chunk: &[u8]) -> Result<bool, ScanFailure> {
        if self.is_done {
            return Ok(true);
        }
        self.bytes_read += chunk.len();
        if self.bytes_read > MAX_SCAN_BYTES {
            return Err(ScanFailure::BudgetExceeded);
        }
        let mut capture_start = self.capture.is_some().then_some(0);
        for (index, &byte) in chunk.iter().enumerate() {
            if self.is_in_string {
                self.consume_string_byte(byte);
                continue;
            }
            match byte {
                b'"' => {
                    if let Some(key) = self.wanted_section_key() {
                        return Err(ScanFailure::SectionNotObject(key));
                    }
                    self.is_in_string = true;
                    let is_key = self.stack.len() <= KEY_CAPTURE_MAX_DEPTH
                        && self.stack.last().is_some_and(|top| {
                            top.kind == FrameKind::Object && top.is_expecting_key
                        });
                    if is_key {
                        self.is_capturing_key = true;
                        self.key_bytes.clear();
                    }
                }
                b' ' | b'\t' | b'\n' | b'\r' => {}
                b':' => {
                    self.is_after_colon = true;
                    if let Some(top) = self.stack.last_mut() {
                        top.is_expecting_key = false;
                    }
                }
                b',' => {
                    self.finish_epoch()?;
                    if let Some(top) = self.stack.last_mut() {
                        top.is_expecting_key = top.kind == FrameKind::Object;
                    }
                    self.pending_key = None;
                    self.is_after_colon = false;
                }
                b'{' | b'[' => self.on_open_bracket(byte, index, &mut capture_start)?,
                b'}' | b']' => {
                    self.on_close_bracket(chunk, index, &mut capture_start)?;
                    if self.is_done {
                        return Ok(true);
                    }
                }
                _ => {
                    if let Some(key) = self.wanted_section_key() {
                        return Err(ScanFailure::SectionNotObject(key));
                    }
                    if self.is_at_epoch_value() {
                        self.epoch_digits.get_or_insert_default().push(byte);
                    }
                }
            }
        }
        if let (Some(capture), Some(start)) = (&mut self.capture, capture_start) {
            capture.buf.extend_from_slice(&chunk[start..]);
        }
        Ok(false)
    }

    /// Validate and return the captured sections. `has_stream_ended` says
    /// whether the caller drained the stream or stopped after `push` returned
    /// `Ok(true)`.
    pub fn finish(self, has_stream_ended: bool) -> Result<ScanResult, ScanFailure> {
        let is_stream_cut = !has_stream_ended || !self.stack.is_empty();
        if !self.is_done && is_stream_cut {
            return Err(ScanFailure::Truncated);
        }
        let epoch = self.epoch.ok_or(ScanFailure::MissingEpoch)?;
        if epoch != self.expected_epoch {
            return Err(ScanFailure::EpochMismatch { found: epoch });
        }
        if let Some(missing) = DIFF_SECTION_KEYS
            .iter()
            .find(|key| !self.sections.contains_key(*key))
        {
            return Err(ScanFailure::MissingSection(missing));
        }
        Ok(ScanResult {
            epoch,
            sections: self.sections,
            bytes_read: self.bytes_read,
            is_cancelled_early: self.is_done,
        })
    }

    fn consume_string_byte(&mut self, byte: u8) {
        if self.is_escaped {
            self.is_escaped = false;
            return;
        }
        match byte {
            b'\\' => self.is_escaped = true,
            b'"' => {
                self.is_in_string = false;
                if self.is_capturing_key {
                    self.pending_key = Some(String::from_utf8_lossy(&self.key_bytes).into_owned());
                    self.is_capturing_key = false;
                }
            }
            _ if self.is_capturing_key => self.key_bytes.push(byte),
            _ => {}
        }
    }

    fn wanted_section_key(&self) -> Option<&'static str> {
        if Some(self.stack.len()) != self.serviceability_depth || !self.is_after_colon {
            return None;
        }
        let pending = self.pending_key.as_deref()?;
        DIFF_SECTION_KEYS.into_iter().find(|key| *key == pending)
    }

    fn is_at_epoch_value(&self) -> bool {
        self.stack.len() == 1
            && self.is_after_colon
            && self.pending_key.as_deref() == Some(EPOCH_KEY)
    }

    fn finish_epoch(&mut self) -> Result<(), ScanFailure> {
        let Some(digits) = self.epoch_digits.take() else {
            return Ok(());
        };
        let value = std::str::from_utf8(&digits)
            .ok()
            .and_then(|text| text.parse::<u32>().ok())
            .ok_or(ScanFailure::MissingEpoch)?;
        let found = Epoch(value);
        if found != self.expected_epoch {
            return Err(ScanFailure::EpochMismatch { found });
        }
        self.epoch = Some(found);
        Ok(())
    }

    fn on_open_bracket(
        &mut self,
        byte: u8,
        index: usize,
        capture_start: &mut Option<usize>,
    ) -> Result<(), ScanFailure> {
        let depth = self.stack.len();
        let is_object = byte == b'{';
        if let Some(key) = self.wanted_section_key() {
            if !is_object {
                return Err(ScanFailure::SectionNotObject(key));
            }
            if !self.sections.contains_key(key) {
                self.capture = Some(Capture {
                    key,
                    buf: Vec::new(),
                    close_depth: depth,
                });
                *capture_start = Some(index);
            }
        }
        let pending = self.pending_key.as_deref();
        if is_object && depth == 1 && pending == Some(FETCH_DATA_KEY) {
            self.fetch_data_depth = Some(depth + 1);
        }
        if is_object && Some(depth) == self.fetch_data_depth && pending == Some(SERVICEABILITY_KEY)
        {
            self.serviceability_depth = Some(depth + 1);
        }
        self.stack.push(Frame {
            kind: if is_object {
                FrameKind::Object
            } else {
                FrameKind::Array
            },
            is_expecting_key: is_object,
        });
        self.pending_key = None;
        self.is_after_colon = false;
        Ok(())
    }

    fn on_close_bracket(
        &mut self,
        chunk: &[u8],
        index: usize,
        capture_start: &mut Option<usize>,
    ) -> Result<(), ScanFailure> {
        self.finish_epoch()?;
        if self.stack.pop().is_none() {
            return Err(ScanFailure::Malformed(format!(
                "closing bracket at depth 0 after {} bytes",
                self.bytes_read
            )));
        }
        let depth = self.stack.len();
        if self
            .capture
            .as_ref()
            .is_some_and(|capture| capture.close_depth == depth)
            && let Some(mut capture) = self.capture.take()
        {
            // Set together with `capture` in `on_open_bracket` or at `push` entry.
            let start = capture_start.take().unwrap_or(0);
            capture.buf.extend_from_slice(&chunk[start..=index]);
            self.sections.insert(capture.key, capture.buf);
            if self.sections.len() == DIFF_SECTION_KEYS.len() {
                self.is_done = true;
            }
        }
        if self.serviceability_depth == Some(depth + 1) {
            self.serviceability_depth = None;
            self.is_done = true;
        }
        if let Some(top) = self.stack.last_mut() {
            top.is_expecting_key = false;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TINY_SNAPSHOT: &str = r#"{"dz_epoch": 7, "solana_epoch": 900, "fetch_data": {"dz_serviceability": {"locations": {"L1": {"code": "nyc"}}, "exchanges": {}, "devices": {"D1": {"location_pk": "L1", "contributor_pk": "C1"}}, "links": {"K1": {"side_a_pk": "D1", "side_z_pk": "D1", "link_type": "WAN", "bandwidth": 10000000000, "contributor_pk": "C1"}}, "users": {}, "contributors": {"C1": {"code": "alpha"}}, "access_passes": {}}, "dz_telemetry": {"device_latency_samples": [{"link_pk": "K1"}]}}, "metadata": {"links": 1}}"#;

    struct LatestReader {
        latest: u32,
    }

    impl SnapshotReader for LatestReader {
        fn fetch_sections(&self, epoch: Epoch) -> BoxFuture<'_, Result<ScanResult, SnapshotError>> {
            Box::pin(async move {
                Err(SnapshotError::Transport {
                    epoch,
                    message: "fetch not supported".to_string(),
                })
            })
        }

        fn has_snapshot(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, SnapshotError>> {
            Box::pin(async move { Ok(epoch.0 <= self.latest) })
        }
    }

    fn scan_all(epoch: Epoch, bytes: &[u8], chunk_size: usize) -> Result<ScanResult, ScanFailure> {
        let mut scanner = SectionScanner::new(epoch);
        let mut has_stream_ended = true;
        for chunk in bytes.chunks(chunk_size) {
            if scanner.push(chunk)? {
                has_stream_ended = false;
                break;
            }
        }
        scanner.finish(has_stream_ended)
    }

    #[test]
    fn object_key_matches_bucket_layout() {
        assert_eq!(
            S3SnapshotReader::object_key(Epoch(211)),
            "mn-epoch-211-snapshot.json"
        );
    }

    #[test]
    fn epoch_displays_as_bare_number() {
        assert_eq!(Epoch(48).to_string(), "48");
        assert_eq!(serde_json::to_string(&Epoch(48)).unwrap(), "48");
    }

    #[test]
    fn scanner_captures_four_sections_and_stops_early() {
        let result = scan_all(Epoch(7), TINY_SNAPSHOT.as_bytes(), 3).unwrap();
        assert_eq!(result.epoch, Epoch(7));
        assert!(result.is_cancelled_early);
        assert_eq!(result.sections.len(), 4);
        assert!(result.bytes_read < TINY_SNAPSHOT.len());
        let links: serde_json::Value = serde_json::from_slice(&result.sections["links"]).unwrap();
        assert_eq!(links["K1"]["link_type"], "WAN");
        let contributors: serde_json::Value =
            serde_json::from_slice(&result.sections["contributors"]).unwrap();
        assert_eq!(contributors["C1"]["code"], "alpha");
        let byte_by_byte = scan_all(Epoch(7), TINY_SNAPSHOT.as_bytes(), 1).unwrap();
        assert_eq!(byte_by_byte.sections, result.sections);
        assert!(byte_by_byte.bytes_read <= result.bytes_read);
    }

    #[test]
    fn scanner_reports_epoch_mismatch_and_truncation() {
        let mismatch = scan_all(Epoch(8), TINY_SNAPSHOT.as_bytes(), 16).unwrap_err();
        assert_eq!(mismatch, ScanFailure::EpochMismatch { found: Epoch(7) });

        let cut = TINY_SNAPSHOT.len() / 2;
        let truncated = scan_all(Epoch(7), &TINY_SNAPSHOT.as_bytes()[..cut], 16).unwrap_err();
        assert_eq!(truncated, ScanFailure::Truncated);
    }

    #[test]
    fn scanner_rejects_a_scalar_section_and_a_closing_bracket_at_depth_zero() {
        let text = TINY_SNAPSHOT.replace(r#""users": {}"#, r#""users": {}, "links": null"#);
        let text = text.replacen(r#""links": {"K1""#, r#""links_old": {"K1""#, 1);
        let failure = scan_all(Epoch(7), text.as_bytes(), 64).unwrap_err();
        assert_eq!(failure, ScanFailure::SectionNotObject("links"));

        let mut scanner = SectionScanner::new(Epoch(7));
        let failure = scanner.push(b"}").unwrap_err();
        assert!(matches!(failure, ScanFailure::Malformed(_)));
        assert_eq!(scanner.bytes_read(), 1);
        assert!(!scanner.is_done());
    }

    #[test]
    fn scanner_enforces_the_byte_budget() {
        let mut scanner = SectionScanner::new(Epoch(7));
        let chunk = vec![b' '; MAX_SCAN_BYTES / 4];
        for _ in 0..4 {
            assert_eq!(scanner.push(&chunk), Ok(false));
        }
        assert_eq!(scanner.push(b" "), Err(ScanFailure::BudgetExceeded));
    }

    #[tokio::test]
    async fn scan_stream_reads_a_byte_stream_to_completion() {
        let body = ByteStream::from(TINY_SNAPSHOT.as_bytes().to_vec());
        let result = scan_stream(Epoch(7), body).await.unwrap();
        assert_eq!(result.epoch, Epoch(7));
        assert_eq!(result.sections.len(), 4);
    }

    #[tokio::test]
    async fn discover_latest_finds_the_highest_epoch() {
        assert_eq!(
            discover_latest(&LatestReader { latest: 211 })
                .await
                .unwrap(),
            Epoch(211)
        );
        assert_eq!(
            discover_latest(&LatestReader { latest: 48 }).await.unwrap(),
            Epoch(48)
        );
        assert_eq!(
            discover_latest(&LatestReader { latest: 100 })
                .await
                .unwrap(),
            Epoch(100)
        );
        assert_eq!(
            discover_latest(&LatestReader { latest: 1599 })
                .await
                .unwrap(),
            Epoch(1599)
        );
    }

    #[test]
    fn sdk_errors_map_by_kind() {
        let timeout: SdkError<aws_sdk_s3::operation::get_object::GetObjectError> =
            SdkError::timeout_error("slow");
        let mapped = map_sdk_error(Epoch(5), timeout, |_| false);
        assert!(matches!(
            mapped,
            SnapshotError::Transport {
                epoch: Epoch(5),
                ..
            }
        ));
        assert!(
            mapped
                .to_string()
                .starts_with("epoch 5: snapshot transport error")
        );
        assert_eq!(
            SnapshotError::NotFound { epoch: Epoch(9) }.to_string(),
            "epoch 9: snapshot HTTP 404"
        );
    }

    #[tokio::test]
    async fn from_env_uses_the_public_bucket_by_default() {
        let reader = S3SnapshotReader::from_env().await;
        let expected = std::env::var("DZ_SNAPSHOT_BUCKET")
            .unwrap_or_else(|_| DEFAULT_SNAPSHOT_BUCKET.to_string());
        assert_eq!(reader.bucket_name(), expected);
    }
}
