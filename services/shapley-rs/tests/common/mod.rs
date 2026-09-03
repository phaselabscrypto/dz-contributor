//! Shared fixtures for the diff tests: an order-preserving JSON renderer,
//! synthetic snapshot builders, and in-memory `SnapshotReader` fakes.
//!
//! `serde_json::Map` sorts keys, so the builders render their own JSON to
//! keep the real snapshot's key order (2-space pretty print).

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use dz_shapley_service::diff::{DiffShape, extract_diff_shape, parse_sections};
use dz_shapley_service::snapshot::{
    BoxFuture, Epoch, ScanFailure, ScanResult, SectionScanner, SnapshotError, SnapshotReader,
};

/// Epoch carried by snapshot A.
pub const EPOCH_A: Epoch = Epoch(148);
/// Epoch carried by snapshot B.
pub const EPOCH_B: Epoch = Epoch(149);
/// Location name that mimics structural JSON inside a string.
pub const DECOY_NAME: &str = r#"He said "links": { \ é →"#;
/// The `dz_serviceability` children the scanner captures.
pub const SECTION_KEYS: [&str; 4] = ["locations", "devices", "links", "contributors"];

/// JSON value whose object keys keep insertion order when rendered.
#[derive(Clone, Debug)]
pub enum Node {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

pub fn text(value: &str) -> Node {
    Node::Text(value.to_string())
}

pub fn num(value: f64) -> Node {
    Node::Number(value)
}

pub fn obj(entries: Vec<(&str, Node)>) -> Node {
    Node::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn render_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        serde_json::to_string(&value).expect("f64 renders")
    }
}

fn push_indent(out: &mut String, indent: usize) {
    for _ in 0..indent {
        out.push_str("  ");
    }
}

fn write_node(node: &Node, indent: usize, out: &mut String) {
    match node {
        Node::Null => out.push_str("null"),
        Node::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Node::Number(value) => out.push_str(&render_number(*value)),
        Node::Text(value) => out.push_str(&serde_json::to_string(value).expect("string renders")),
        Node::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                push_indent(out, indent + 1);
                write_node(item, indent + 1, out);
                if index + 1 < items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            push_indent(out, indent);
            out.push(']');
        }
        Node::Object(entries) => {
            if entries.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            for (index, (key, value)) in entries.iter().enumerate() {
                push_indent(out, indent + 1);
                out.push_str(&serde_json::to_string(key).expect("key renders"));
                out.push_str(": ");
                write_node(value, indent + 1, out);
                if index + 1 < entries.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            push_indent(out, indent);
            out.push('}');
        }
    }
}

/// Pretty-printed JSON text in insertion order.
pub fn render(node: &Node) -> String {
    let mut out = String::new();
    write_node(node, 0, &mut out);
    out
}

/// Rendered snapshot bytes.
pub fn snapshot_bytes(node: &Node) -> Vec<u8> {
    render(node).into_bytes()
}

fn location(code: &str, name: &str) -> Node {
    obj(vec![
        ("code", text(code)),
        ("name", text(name)),
        ("country", text("US")),
        ("lat", num(40.7)),
        ("lng", num(-74.0)),
        ("status", text("activated")),
    ])
}

fn device(code: &str, location_pk: &str, contributor_pk: &str, has_interfaces: bool) -> Node {
    let interfaces = if has_interfaces {
        Node::Array(vec![obj(vec![(
            "V2",
            obj(vec![
                ("name", text("eth0")),
                ("links", Node::Array(vec![text("K1")])),
                ("status", text("activated")),
            ]),
        )])])
    } else {
        Node::Array(Vec::new())
    };
    obj(vec![
        ("code", text(code)),
        ("location_pk", text(location_pk)),
        ("contributor_pk", text(contributor_pk)),
        ("status", text("activated")),
        ("interfaces", interfaces),
    ])
}

fn link(
    code: &str,
    side_a: &str,
    side_z: &str,
    contributor_pk: &str,
    bandwidth: f64,
    link_type: &str,
) -> Node {
    obj(vec![
        ("code", text(code)),
        ("side_a_pk", text(side_a)),
        ("side_z_pk", text(side_z)),
        ("link_type", text(link_type)),
        ("bandwidth", num(bandwidth)),
        ("mtu", num(9000.0)),
        ("delay_ns", num(12_345_678.0)),
        ("contributor_pk", text(contributor_pk)),
        ("status", text("activated")),
    ])
}

fn contributor(code: &str) -> Node {
    obj(vec![("code", text(code)), ("status", text("activated"))])
}

fn locations_section() -> Node {
    obj(vec![
        ("L1", location("nyc", "New York")),
        ("L2", location("lon", DECOY_NAME)),
        ("L3", location("fra", "Frankfurt")),
    ])
}

fn devices_section() -> Node {
    obj(vec![
        ("D1", device("nyc1", "L1", "C1", false)),
        ("D2", device("lon1", "L2", "C1", true)),
        ("D3", device("fra1", "L3", "C2", false)),
        ("D4", device("unk1", "LX", "CX", false)),
    ])
}

fn links_a() -> Node {
    obj(vec![
        ("K1", link("nyc-lon", "D1", "D2", "C1", 10e9, "WAN")),
        ("K2", link("lon-fra", "D2", "D3", "C2", 100e9, "WAN")),
        ("K3", link("nyc-fra", "D1", "D3", "C1", 40e9, "WAN")),
        ("K5", link("unk-nyc", "D4", "D1", "CX", 1e9, "WAN")),
    ])
}

fn links_b() -> Node {
    obj(vec![
        ("K1", link("nyc-lon", "D1", "D2", "C1", 20e9, "WAN")),
        ("K3", link("nyc-fra", "D1", "D3", "C1", 40e9, "DZX")),
        ("K4", link("fra-nyc", "D3", "D1", "C2", 10e9, "WAN")),
        ("K5", link("unk-nyc", "D4", "D1", "CX", 1e9, "WAN")),
    ])
}

fn contributors_a() -> Node {
    obj(vec![
        ("C1", contributor("alpha")),
        ("C2", contributor("beta")),
    ])
}

fn contributors_b() -> Node {
    obj(vec![
        ("C1", contributor("alpha")),
        ("C2", contributor("beta")),
        ("C3", contributor("gamma")),
    ])
}

fn serviceability_entries(links: Node, contributors: Node) -> Vec<(&'static str, Node)> {
    vec![
        ("locations", locations_section()),
        (
            "exchanges",
            obj(vec![("X1", obj(vec![("code", text("xnyc"))]))]),
        ),
        ("devices", devices_section()),
        ("links", links),
        (
            "users",
            obj(vec![("U1", obj(vec![("status", text("activated"))]))]),
        ),
        ("multicast_groups", obj(Vec::new())),
        ("contributors", contributors),
        (
            "access_passes",
            obj(vec![("P1", obj(vec![("status", text("activated"))]))]),
        ),
    ]
}

fn telemetry_section() -> Node {
    let samples: Vec<Node> = (0..2_000)
        .map(|record| {
            let values: Vec<Node> = (0..50)
                .map(|sample| num(f64::from(record * 50 + sample)))
                .collect();
            obj(vec![
                ("link_pk", text("K1")),
                ("device_a_pk", text("D1")),
                ("samples", Node::Array(values)),
            ])
        })
        .collect();
    obj(vec![("device_latency_samples", Node::Array(samples))])
}

fn build_snapshot(epoch: Option<u32>, serviceability: Vec<(&str, Node)>) -> Node {
    let mut top: Vec<(&str, Node)> = Vec::new();
    if let Some(epoch) = epoch {
        top.push(("dz_epoch", num(f64::from(epoch))));
    }
    top.push(("solana_epoch", num(900.0)));
    top.push((
        "fetch_data",
        obj(vec![
            ("dz_serviceability", obj(serviceability)),
            ("dz_telemetry", telemetry_section()),
            (
                "dz_internet",
                obj(vec![(
                    "internet_latency_samples",
                    Node::Array(vec![obj(vec![
                        ("link_pk", text("K2")),
                        ("rtt_us", num(1.0)),
                    ])]),
                )]),
            ),
        ]),
    ));
    top.push((
        "leader_schedule",
        obj(vec![("V1", Node::Array(vec![num(1.0), num(2.0)]))]),
    ));
    top.push((
        "metadata",
        obj(vec![("devices_count", num(4.0)), ("links", num(4.0))]),
    ));
    obj(top)
}

/// Snapshot A: epoch 148, two contributors, four links, decoys in strings.
pub fn snapshot_a() -> Node {
    build_snapshot(
        Some(EPOCH_A.0),
        serviceability_entries(links_a(), contributors_a()),
    )
}

/// Snapshot B: epoch 149. K2 removed, K4 added, K1 bandwidth 20, K3 type DZX, gamma joins.
pub fn snapshot_b() -> Node {
    build_snapshot(
        Some(EPOCH_B.0),
        serviceability_entries(links_b(), contributors_b()),
    )
}

/// Snapshot A with `dz_serviceability` children in a different order.
pub fn snapshot_a_reordered() -> Node {
    let mut entries = serviceability_entries(links_a(), contributors_a());
    let order = [
        "contributors",
        "links",
        "devices",
        "locations",
        "exchanges",
        "users",
        "multicast_groups",
        "access_passes",
    ];
    let mut reordered = Vec::with_capacity(entries.len());
    for key in order {
        let index = entries
            .iter()
            .position(|(entry_key, _)| *entry_key == key)
            .expect("key present");
        reordered.push(entries.remove(index));
    }
    build_snapshot(Some(EPOCH_A.0), reordered)
}

/// Snapshot A without `dz_epoch`.
pub fn snapshot_a_without_epoch() -> Node {
    build_snapshot(None, serviceability_entries(links_a(), contributors_a()))
}

/// One `dz_serviceability` child of a snapshot node.
pub fn section<'a>(node: &'a Node, key: &str) -> &'a Node {
    fn child<'n>(parent: &'n Node, name: &str) -> &'n Node {
        let Node::Object(entries) = parent else {
            panic!("{name}: parent is not an object");
        };
        &entries
            .iter()
            .find(|(entry_key, _)| entry_key == name)
            .unwrap_or_else(|| panic!("{name} missing"))
            .1
    }
    child(child(child(node, "fetch_data"), "dz_serviceability"), key)
}

/// One section as a `serde_json::Value`, for equality checks.
pub fn section_value(node: &Node, key: &str) -> serde_json::Value {
    serde_json::from_str(&render(section(node, key))).expect("section renders as JSON")
}

/// Byte offset of the first occurrence of `needle`.
pub fn offset_of(haystack: &[u8], needle: &str) -> usize {
    haystack
        .windows(needle.len())
        .position(|window| window == needle.as_bytes())
        .unwrap_or_else(|| panic!("{needle:?} not found"))
}

/// Feed chunks to a scanner; the error carries the bytes read so far.
pub fn scan_chunks<'a>(
    epoch: Epoch,
    chunks: impl Iterator<Item = &'a [u8]>,
) -> Result<ScanResult, (usize, ScanFailure)> {
    let mut scanner = SectionScanner::new(epoch);
    let mut has_stream_ended = true;
    for chunk in chunks {
        match scanner.push(chunk) {
            Ok(true) => {
                has_stream_ended = false;
                break;
            }
            Ok(false) => {}
            Err(failure) => return Err((scanner.bytes_read(), failure)),
        }
    }
    let bytes_read = scanner.bytes_read();
    scanner
        .finish(has_stream_ended)
        .map_err(|failure| (bytes_read, failure))
}

/// Scan `bytes` in fixed-size chunks.
pub fn scan_chunked(
    epoch: Epoch,
    bytes: &[u8],
    chunk_size: usize,
) -> Result<ScanResult, ScanFailure> {
    scan_chunks(epoch, bytes.chunks(chunk_size)).map_err(|(_, failure)| failure)
}

/// Scan `bytes` split at the given ascending offsets.
pub fn scan_at_splits(
    epoch: Epoch,
    bytes: &[u8],
    splits: &[usize],
) -> Result<ScanResult, ScanFailure> {
    let mut chunks = Vec::with_capacity(splits.len() + 1);
    let mut start = 0;
    for &split in splits {
        chunks.push(&bytes[start..split]);
        start = split;
    }
    chunks.push(&bytes[start..]);
    scan_chunks(epoch, chunks.into_iter()).map_err(|(_, failure)| failure)
}

/// Scan, parse and extract a snapshot node in one step.
pub fn shape_of(epoch: Epoch, node: &Node) -> DiffShape {
    let bytes = snapshot_bytes(node);
    let scan = scan_chunked(epoch, &bytes, 4096).expect("scan succeeds");
    let sections = parse_sections(&scan).expect("sections parse");
    extract_diff_shape(epoch, &sections)
}

/// In-memory reader serving rendered snapshot bytes per epoch and counting
/// fetches.
pub struct FakeSnapshotReader {
    snapshots: HashMap<Epoch, Vec<u8>>,
    chunk_size: usize,
    fetch_calls: AtomicUsize,
}

impl FakeSnapshotReader {
    pub fn new(chunk_size: usize) -> Self {
        Self {
            snapshots: HashMap::new(),
            chunk_size,
            fetch_calls: AtomicUsize::new(0),
        }
    }

    pub fn insert(&mut self, epoch: Epoch, node: &Node) {
        self.snapshots.insert(epoch, snapshot_bytes(node));
    }

    pub fn fetch_calls(&self) -> usize {
        self.fetch_calls.load(Ordering::SeqCst)
    }
}

impl SnapshotReader for FakeSnapshotReader {
    fn fetch_sections(&self, epoch: Epoch) -> BoxFuture<'_, Result<ScanResult, SnapshotError>> {
        Box::pin(async move {
            self.fetch_calls.fetch_add(1, Ordering::SeqCst);
            let bytes = self
                .snapshots
                .get(&epoch)
                .ok_or(SnapshotError::NotFound { epoch })?;
            scan_chunks(epoch, bytes.chunks(self.chunk_size)).map_err(|(bytes_read, failure)| {
                SnapshotError::Scan {
                    epoch,
                    bytes_read,
                    failure,
                }
            })
        })
    }

    fn has_snapshot(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, SnapshotError>> {
        Box::pin(async move { Ok(self.snapshots.contains_key(&epoch)) })
    }
}

/// Reader whose every call fails with a transport error.
pub struct NeverReader;

impl SnapshotReader for NeverReader {
    fn fetch_sections(&self, epoch: Epoch) -> BoxFuture<'_, Result<ScanResult, SnapshotError>> {
        Box::pin(async move {
            Err(SnapshotError::Transport {
                epoch,
                message: "reader disabled in tests".to_string(),
            })
        })
    }

    fn has_snapshot(&self, epoch: Epoch) -> BoxFuture<'_, Result<bool, SnapshotError>> {
        Box::pin(async move {
            Err(SnapshotError::Transport {
                epoch,
                message: "reader disabled in tests".to_string(),
            })
        })
    }
}
