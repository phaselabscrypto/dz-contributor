//! Diff shapes and the pure diff computations served by the `/diff*` routes.
//!
//! Field names are the public JSON contract shared with `lib/types/diff.ts`
//! in the Next.js app; the two must change together.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::marker::PhantomData;
use std::sync::Arc;
use std::time::SystemTime;

use aws_sdk_s3::primitives::{DateTime, DateTimeFormat};
use serde::de::{Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};

use crate::snapshot::{
    DIFF_SECTION_KEYS, Epoch, MIN_DZ_EPOCH, ScanFailure, ScanResult, SnapshotError,
};

/// Highest epoch a diff window may name.
pub(crate) const MAX_DIFF_EPOCH: Epoch = Epoch(100_000);
/// Widest `|to - from|` a diff window may span.
pub(crate) const MAX_DIFF_WINDOW: u32 = 200;

const UNKNOWN_CONTRIBUTOR_CODE: &str = "unknown";
const ENDPOINT_SEPARATOR: &str = "↔";
const WINDOW_REQUIRED_MESSAGE: &str = "from and to query params required (different integers)";
const WINDOW_BOUNDS_MESSAGE: &str = "from and to must be in [48, 100000]";
const WINDOW_TOO_WIDE_MESSAGE: &str = "epoch window too wide: |to - from| must be <= 200";
const UNIX_EPOCH_RFC3339: &str = "1970-01-01T00:00:00Z";

/// Snapshot location record; only the field the extractor reads.
#[derive(Debug, Deserialize)]
pub(crate) struct RawLocation {
    pub(crate) code: String,
}

/// Snapshot contributor record; only the field the extractor reads.
#[derive(Debug, Deserialize)]
pub(crate) struct RawContributor {
    pub(crate) code: String,
}

/// Snapshot device record; only the fields the extractor reads.
#[derive(Debug, Deserialize)]
pub(crate) struct RawDevice {
    pub(crate) location_pk: String,
    pub(crate) contributor_pk: String,
}

/// Snapshot link record; only the fields the extractor reads.
#[derive(Debug, Deserialize)]
pub(crate) struct RawLink {
    pub(crate) side_a_pk: String,
    pub(crate) side_z_pk: String,
    pub(crate) link_type: String,
    pub(crate) bandwidth: f64,
    pub(crate) contributor_pk: String,
}

/// JSON object deserialized as an ordered list of (key, value). Keeps file
/// order, which `serde_json::Map` does not.
#[derive(Debug)]
pub struct OrderedMap<T>(pub Vec<(String, T)>);

struct OrderedMapVisitor<T>(PhantomData<T>);

impl<'de, T: Deserialize<'de>> Visitor<'de> for OrderedMapVisitor<T> {
    type Value = OrderedMap<T>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
        let mut entries = Vec::with_capacity(access.size_hint().unwrap_or(0));
        while let Some(entry) = access.next_entry::<String, T>()? {
            entries.push(entry);
        }
        Ok(OrderedMap(entries))
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for OrderedMap<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(OrderedMapVisitor(PhantomData))
    }
}

/// The four parsed `dz_serviceability` sections, in file order.
#[derive(Debug)]
pub struct DiffSections {
    pub(crate) locations: OrderedMap<RawLocation>,
    pub(crate) devices: OrderedMap<RawDevice>,
    pub(crate) links: OrderedMap<RawLink>,
    pub(crate) contributors: OrderedMap<RawContributor>,
}

fn parse_section<'a, T: Deserialize<'a>>(
    scan: &'a ScanResult,
    key: &'static str,
) -> Result<OrderedMap<T>, SnapshotError> {
    let scan_error = |failure: ScanFailure| SnapshotError::Scan {
        epoch: scan.epoch,
        bytes_read: scan.bytes_read,
        failure,
    };
    let bytes = scan
        .sections
        .get(key)
        .ok_or_else(|| scan_error(ScanFailure::MissingSection(key)))?;
    let first_byte = bytes.iter().find(|byte| !byte.is_ascii_whitespace());
    if first_byte != Some(&b'{') {
        return Err(scan_error(ScanFailure::SectionNotObject(key)));
    }
    serde_json::from_slice(bytes)
        .map_err(|error| scan_error(ScanFailure::Malformed(format!("section {key}: {error}"))))
}

/// Parse every captured section. A section that is not a JSON object fails
/// with `ScanFailure::SectionNotObject`; one whose records lack a field the
/// extractor reads fails with `ScanFailure::Malformed`.
pub fn parse_sections(scan: &ScanResult) -> Result<DiffSections, SnapshotError> {
    let [locations_key, devices_key, links_key, contributors_key] = DIFF_SECTION_KEYS;
    Ok(DiffSections {
        locations: parse_section(scan, locations_key)?,
        devices: parse_section(scan, devices_key)?,
        links: parse_section(scan, links_key)?,
        contributors: parse_section(scan, contributors_key)?,
    })
}

/// One link as the diff sees it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    /// Link account pubkey.
    pub pubkey: String,
    /// Owning contributor code, or `"unknown"`.
    pub contributor_code: String,
    /// Location code of the side A device, or `""`.
    pub side_a_code: String,
    /// Location code of the side Z device, or `""`.
    pub side_z_code: String,
    /// Bandwidth in Gbps.
    pub bandwidth_gbps: f64,
    /// Link type as written in the snapshot.
    pub link_type: String,
}

/// One contributor's footprint in an epoch.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContributorRef {
    /// Contributor code.
    pub code: String,
    /// Links owned.
    pub link_count: u32,
    /// Devices owned.
    pub device_count: u32,
    /// Distinct location codes across the devices owned.
    pub metro_count: u32,
}

/// The lean per-epoch projection the diff index persists.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffShape {
    /// Epoch the shape was extracted from.
    pub epoch: Epoch,
    /// Links in file order.
    pub links: Vec<LinkRef>,
    /// Contributors in file order.
    pub contributors: Vec<ContributorRef>,
}

fn count_u32(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// Project the parsed sections onto a [`DiffShape`].
pub fn extract_diff_shape(epoch: Epoch, sections: &DiffSections) -> DiffShape {
    let location_code: HashMap<&str, &str> = sections
        .locations
        .0
        .iter()
        .map(|(pubkey, location)| (pubkey.as_str(), location.code.as_str()))
        .collect();
    let contributor_code: HashMap<&str, &str> = sections
        .contributors
        .0
        .iter()
        .map(|(pubkey, contributor)| (pubkey.as_str(), contributor.code.as_str()))
        .collect();

    let mut device_location_code: HashMap<&str, &str> = HashMap::new();
    let mut devices_by_contributor: HashMap<&str, u32> = HashMap::new();
    let mut metros_by_contributor: HashMap<&str, HashSet<&str>> = HashMap::new();
    for (pubkey, device) in &sections.devices.0 {
        let device_location = location_code
            .get(device.location_pk.as_str())
            .copied()
            .unwrap_or("");
        device_location_code.insert(pubkey.as_str(), device_location);
        let owner = contributor_code
            .get(device.contributor_pk.as_str())
            .copied()
            .unwrap_or(UNKNOWN_CONTRIBUTOR_CODE);
        *devices_by_contributor.entry(owner).or_default() += 1;
        if !device_location.is_empty() {
            metros_by_contributor
                .entry(owner)
                .or_default()
                .insert(device_location);
        }
    }

    let mut links = Vec::with_capacity(sections.links.0.len());
    let mut links_by_contributor: HashMap<&str, u32> = HashMap::new();
    for (pubkey, link) in &sections.links.0 {
        let owner = contributor_code
            .get(link.contributor_pk.as_str())
            .copied()
            .unwrap_or(UNKNOWN_CONTRIBUTOR_CODE);
        let side_code = |device_pk: &str| {
            device_location_code
                .get(device_pk)
                .copied()
                .unwrap_or("")
                .to_string()
        };
        links.push(LinkRef {
            pubkey: pubkey.clone(),
            contributor_code: owner.to_string(),
            side_a_code: side_code(&link.side_a_pk),
            side_z_code: side_code(&link.side_z_pk),
            bandwidth_gbps: link.bandwidth / 1e9,
            link_type: link.link_type.clone(),
        });
        *links_by_contributor.entry(owner).or_default() += 1;
    }

    let contributors = sections
        .contributors
        .0
        .iter()
        .map(|(_, contributor)| {
            let code = contributor.code.as_str();
            ContributorRef {
                code: code.to_string(),
                link_count: links_by_contributor.get(code).copied().unwrap_or(0),
                device_count: devices_by_contributor.get(code).copied().unwrap_or(0),
                metro_count: metros_by_contributor
                    .get(code)
                    .map_or(0, |metros| count_u32(metros.len())),
            }
        })
        .collect();

    DiffShape {
        epoch,
        links,
        contributors,
    }
}

/// A validated `from`/`to` pair. `from` may be greater than `to`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EpochWindow {
    /// The `before` epoch.
    pub from: Epoch,
    /// The `after` epoch.
    pub to: Epoch,
}

fn parse_epoch_param(raw: Option<&str>) -> Option<i64> {
    raw?.trim().parse::<i64>().ok()
}

/// Validate the raw query parameters. The three messages are the exact
/// strings the Next.js route emits today.
pub fn validate_window(from: Option<&str>, to: Option<&str>) -> Result<EpochWindow, &'static str> {
    let (Some(from), Some(to)) = (parse_epoch_param(from), parse_epoch_param(to)) else {
        return Err(WINDOW_REQUIRED_MESSAGE);
    };
    if from == to {
        return Err(WINDOW_REQUIRED_MESSAGE);
    }
    let bounds = i64::from(MIN_DZ_EPOCH.0)..=i64::from(MAX_DIFF_EPOCH.0);
    if !bounds.contains(&from) || !bounds.contains(&to) {
        return Err(WINDOW_BOUNDS_MESSAGE);
    }
    if (to - from).abs() > i64::from(MAX_DIFF_WINDOW) {
        return Err(WINDOW_TOO_WIDE_MESSAGE);
    }
    // Both values passed the bounds check, so they fit in u32.
    let to_epoch = |value: i64| Epoch(u32::try_from(value).unwrap_or(MAX_DIFF_EPOCH.0));
    Ok(EpochWindow {
        from: to_epoch(from),
        to: to_epoch(to),
    })
}

/// A changed field's value: a number for bandwidth, text otherwise.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum FieldValue {
    /// Bandwidth in Gbps.
    Number(f64),
    /// Link type or endpoint text.
    Text(String),
}

/// Which link field a [`ChangedEntry`] reports.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangedField {
    /// `bandwidthGbps` differs.
    BandwidthGbps,
    /// `linkType` differs.
    LinkType,
    /// Either side code differs; values are `"A↔Z"` text.
    Endpoint,
}

/// A link plus the epoch its addition or removal was first observed in.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttributedLinkRef {
    /// The link as seen in the epoch that defines the entry.
    #[serde(flatten)]
    pub link: LinkRef,
    /// First epoch in `(from, to]` where the entry holds.
    pub first_observed_epoch: Epoch,
}

/// One changed field of one link.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedEntry {
    /// Link account pubkey.
    pub pubkey: String,
    /// Contributor code as of `after`.
    pub contributor_code: String,
    /// The field that changed.
    pub field: ChangedField,
    /// Value in `before`.
    pub before: FieldValue,
    /// Value in `after`.
    pub after: FieldValue,
    /// First epoch in `(from, to]` where the link carries the `after` value.
    pub first_observed_epoch: Epoch,
}

/// Network-wide counts.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiffSummary {
    /// Links present in `after` only.
    pub links_added: u32,
    /// Links present in `before` only.
    pub links_removed: u32,
    /// Changed field entries.
    pub links_changed: u32,
    /// Rollup rows with activity.
    pub contributors_affected: u32,
}

/// Per-contributor rollup row.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContributorRollupRow {
    /// Contributor code.
    pub code: String,
    /// Link count in `before`.
    pub before_link_count: u32,
    /// Link count in `after`.
    pub after_link_count: u32,
    /// Device count in `before`.
    pub before_device_count: u32,
    /// Device count in `after`.
    pub after_device_count: u32,
    /// Metro count in `before`.
    pub before_metro_count: u32,
    /// Metro count in `after`.
    pub after_metro_count: u32,
    /// Added links owned by this contributor.
    pub links_added: u32,
    /// Removed links owned by this contributor.
    pub links_removed: u32,
    /// Changed field entries owned by this contributor.
    pub links_changed: u32,
    /// Sum of link bandwidth in `before`, 0 when absent from `before`.
    pub bandwidth_gbps_before: f64,
    /// Sum of link bandwidth in `after`, 0 when absent from `after`.
    pub bandwidth_gbps_after: f64,
    /// `bandwidth_gbps_after - bandwidth_gbps_before`.
    pub bandwidth_gbps_delta: f64,
    /// Present in `after` only.
    pub first_seen: bool,
    /// Present in `before` only.
    pub left_network: bool,
}

/// Body of `GET /diff`.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiffResponse {
    /// The `before` epoch.
    pub from: Epoch,
    /// The `after` epoch.
    pub to: Epoch,
    /// Network-wide counts.
    pub summary: NetworkDiffSummary,
    /// Rollup rows with activity, sorted by impact.
    pub contributors: Vec<ContributorRollupRow>,
    /// Links present in `after` only, in `after` file order.
    pub added: Vec<AttributedLinkRef>,
    /// Links present in `before` only, in `before` file order.
    pub removed: Vec<AttributedLinkRef>,
    /// One entry per changed field, in `after` file order.
    pub changed: Vec<ChangedEntry>,
    /// RFC 3339 time the response was computed.
    pub fetched_at: String,
}

fn index_links(links: &[LinkRef]) -> HashMap<&str, &LinkRef> {
    links
        .iter()
        .map(|link| (link.pubkey.as_str(), link))
        .collect()
}

fn endpoint_text(link: &LinkRef) -> String {
    format!(
        "{}{ENDPOINT_SEPARATOR}{}",
        link.side_a_code, link.side_z_code
    )
}

fn sum_bandwidth(links: &[LinkRef], code: &str) -> f64 {
    links
        .iter()
        .filter(|link| link.contributor_code == code)
        .fold(0.0, |total, link| total + link.bandwidth_gbps)
}

fn has_after_value(link: &LinkRef, field: ChangedField, after: &FieldValue) -> bool {
    match (field, after) {
        (ChangedField::BandwidthGbps, FieldValue::Number(value)) => link.bandwidth_gbps == *value,
        (ChangedField::LinkType, FieldValue::Text(value)) => link.link_type == *value,
        (ChangedField::Endpoint, FieldValue::Text(value)) => endpoint_text(link) == *value,
        _ => false,
    }
}

/// Network diff between two shapes. `intermediates` are the shapes for
/// `from+1 ..= to-1`, ascending, gaps allowed; attribution defaults to `to`.
pub fn compute_network_diff(
    before: &DiffShape,
    after: &DiffShape,
    intermediates: &[Arc<DiffShape>],
    fetched_at: String,
) -> NetworkDiffResponse {
    let before_links = index_links(&before.links);
    let after_links = index_links(&after.links);
    let intermediate_links: Vec<(Epoch, HashMap<&str, &LinkRef>)> = intermediates
        .iter()
        .map(|shape| (shape.epoch, index_links(&shape.links)))
        .collect();
    let fallback_epoch = after.epoch;

    let mut added = Vec::new();
    let mut changed = Vec::new();
    for link in &after.links {
        let Some(previous) = before_links.get(link.pubkey.as_str()) else {
            let first_observed_epoch = intermediate_links
                .iter()
                .find(|(_, links)| links.contains_key(link.pubkey.as_str()))
                .map_or(fallback_epoch, |(epoch, _)| *epoch);
            added.push(AttributedLinkRef {
                link: link.clone(),
                first_observed_epoch,
            });
            continue;
        };
        let mut differences = Vec::new();
        if previous.bandwidth_gbps != link.bandwidth_gbps {
            differences.push((
                ChangedField::BandwidthGbps,
                FieldValue::Number(previous.bandwidth_gbps),
                FieldValue::Number(link.bandwidth_gbps),
            ));
        }
        if previous.link_type != link.link_type {
            differences.push((
                ChangedField::LinkType,
                FieldValue::Text(previous.link_type.clone()),
                FieldValue::Text(link.link_type.clone()),
            ));
        }
        if previous.side_a_code != link.side_a_code || previous.side_z_code != link.side_z_code {
            differences.push((
                ChangedField::Endpoint,
                FieldValue::Text(endpoint_text(previous)),
                FieldValue::Text(endpoint_text(link)),
            ));
        }
        for (field, before_value, after_value) in differences {
            let first_observed_epoch = intermediate_links
                .iter()
                .find(|(_, links)| {
                    links
                        .get(link.pubkey.as_str())
                        .is_some_and(|hit| has_after_value(hit, field, &after_value))
                })
                .map_or(fallback_epoch, |(epoch, _)| *epoch);
            changed.push(ChangedEntry {
                pubkey: link.pubkey.clone(),
                contributor_code: link.contributor_code.clone(),
                field,
                before: before_value,
                after: after_value,
                first_observed_epoch,
            });
        }
    }

    let removed: Vec<AttributedLinkRef> = before
        .links
        .iter()
        .filter(|link| !after_links.contains_key(link.pubkey.as_str()))
        .map(|link| AttributedLinkRef {
            link: link.clone(),
            first_observed_epoch: intermediate_links
                .iter()
                .find(|(_, links)| !links.contains_key(link.pubkey.as_str()))
                .map_or(fallback_epoch, |(epoch, _)| *epoch),
        })
        .collect();

    let before_by_code: HashMap<&str, &ContributorRef> = before
        .contributors
        .iter()
        .map(|contributor| (contributor.code.as_str(), contributor))
        .collect();
    let after_by_code: HashMap<&str, &ContributorRef> = after
        .contributors
        .iter()
        .map(|contributor| (contributor.code.as_str(), contributor))
        .collect();
    let mut seen_codes = HashSet::new();
    let codes = before
        .contributors
        .iter()
        .chain(after.contributors.iter())
        .map(|contributor| contributor.code.as_str())
        .filter(|code| seen_codes.insert(*code));

    let mut contributors: Vec<ContributorRollupRow> = codes
        .filter_map(|code| {
            let previous = before_by_code.get(code).copied();
            let next = after_by_code.get(code).copied();
            let owns = |entry_code: &str| entry_code == code;
            let links_added = count_u32(
                added
                    .iter()
                    .filter(|entry| owns(&entry.link.contributor_code))
                    .count(),
            );
            let links_removed = count_u32(
                removed
                    .iter()
                    .filter(|entry| owns(&entry.link.contributor_code))
                    .count(),
            );
            let links_changed = count_u32(
                changed
                    .iter()
                    .filter(|entry| owns(&entry.contributor_code))
                    .count(),
            );
            let bandwidth_gbps_before =
                previous.map_or(0.0, |_| sum_bandwidth(&before.links, code));
            let bandwidth_gbps_after = next.map_or(0.0, |_| sum_bandwidth(&after.links, code));
            let first_seen = previous.is_none() && next.is_some();
            let left_network = previous.is_some() && next.is_none();
            let has_activity = links_added > 0
                || links_removed > 0
                || links_changed > 0
                || first_seen
                || left_network;
            has_activity.then(|| ContributorRollupRow {
                code: code.to_string(),
                before_link_count: previous.map_or(0, |c| c.link_count),
                after_link_count: next.map_or(0, |c| c.link_count),
                before_device_count: previous.map_or(0, |c| c.device_count),
                after_device_count: next.map_or(0, |c| c.device_count),
                before_metro_count: previous.map_or(0, |c| c.metro_count),
                after_metro_count: next.map_or(0, |c| c.metro_count),
                links_added,
                links_removed,
                links_changed,
                bandwidth_gbps_before,
                bandwidth_gbps_after,
                bandwidth_gbps_delta: bandwidth_gbps_after - bandwidth_gbps_before,
                first_seen,
                left_network,
            })
        })
        .collect();
    contributors.sort_by(|left, right| {
        right
            .bandwidth_gbps_delta
            .abs()
            .total_cmp(&left.bandwidth_gbps_delta.abs())
            .then_with(|| {
                (right.links_added + right.links_removed)
                    .cmp(&(left.links_added + left.links_removed))
            })
    });

    NetworkDiffResponse {
        from: before.epoch,
        to: after.epoch,
        summary: NetworkDiffSummary {
            links_added: count_u32(added.len()),
            links_removed: count_u32(removed.len()),
            links_changed: count_u32(changed.len()),
            contributors_affected: count_u32(contributors.len()),
        },
        contributors,
        added,
        removed,
        changed,
        fetched_at,
    }
}

/// The two link fields the contributor diff compares.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkAttrs {
    /// Bandwidth in Gbps.
    pub bandwidth_gbps: f64,
    /// Link type.
    pub link_type: String,
}

/// One link whose attributes changed between the two epochs.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkChange {
    /// Link account pubkey.
    pub pubkey: String,
    /// Contributor code as of `after`.
    pub contributor_code: String,
    /// Side A location code as of `after`.
    pub side_a_code: String,
    /// Side Z location code as of `after`.
    pub side_z_code: String,
    /// Attributes in `before`.
    pub before: LinkAttrs,
    /// Attributes in `after`.
    pub after: LinkAttrs,
}

/// Footprint counts of one contributor in one epoch.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FootprintCounts {
    /// Links owned.
    pub link_count: u32,
    /// Devices owned.
    pub device_count: u32,
    /// Distinct metros.
    pub metro_count: u32,
}

/// Before and after footprint of one contributor.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContributorFootprint {
    /// Counts in `before`; zeros when absent.
    pub before: FootprintCounts,
    /// Counts in `after`; zeros when absent.
    pub after: FootprintCounts,
    /// Present in `after` only.
    pub first_seen: bool,
    /// Present in `before` only.
    pub left_network: bool,
}

/// Contributor-scoped counts.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContributorDiffSummary {
    /// Links present in `after` only.
    pub links_added: u32,
    /// Links present in `before` only.
    pub links_removed: u32,
    /// Links present in both with a different bandwidth or link type.
    pub links_changed: u32,
    /// Sum of link bandwidth in `before`.
    pub bandwidth_gbps_before: f64,
    /// Sum of link bandwidth in `after`.
    pub bandwidth_gbps_after: f64,
    /// `bandwidth_gbps_after - bandwidth_gbps_before`.
    pub bandwidth_gbps_delta: f64,
}

/// Body of `GET /diff/contributor/:code`. `name` is absent on purpose; the
/// Next.js proxy adds the display name.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContributorDiffResponse {
    /// Contributor code as requested.
    pub code: String,
    /// The `before` epoch.
    pub from: Epoch,
    /// The `after` epoch.
    pub to: Epoch,
    /// Contributor-scoped counts.
    pub summary: ContributorDiffSummary,
    /// Before and after footprint.
    pub footprint: ContributorFootprint,
    /// Links present in `after` only, in `after` file order.
    pub added: Vec<LinkRef>,
    /// Links present in `before` only, in `before` file order.
    pub removed: Vec<LinkRef>,
    /// Links with a changed bandwidth or link type, in `after` file order.
    pub changed: Vec<LinkChange>,
    /// RFC 3339 time the response was computed.
    pub fetched_at: String,
}

fn footprint_counts(contributor: Option<&ContributorRef>) -> FootprintCounts {
    FootprintCounts {
        link_count: contributor.map_or(0, |c| c.link_count),
        device_count: contributor.map_or(0, |c| c.device_count),
        metro_count: contributor.map_or(0, |c| c.metro_count),
    }
}

/// Contributor-scoped diff between two shapes. Only links owned by `code` in
/// the respective epoch take part; only bandwidth and link type are compared.
pub fn compute_contributor_diff(
    before: &DiffShape,
    after: &DiffShape,
    code: &str,
    fetched_at: String,
) -> ContributorDiffResponse {
    let owned = |link: &&LinkRef| link.contributor_code == code;
    let before_links: HashMap<&str, &LinkRef> = before
        .links
        .iter()
        .filter(owned)
        .map(|link| (link.pubkey.as_str(), link))
        .collect();
    let after_links: HashMap<&str, &LinkRef> = after
        .links
        .iter()
        .filter(owned)
        .map(|link| (link.pubkey.as_str(), link))
        .collect();

    let mut added = Vec::new();
    let mut changed = Vec::new();
    for link in after.links.iter().filter(owned) {
        match before_links.get(link.pubkey.as_str()) {
            None => added.push(link.clone()),
            Some(previous) => {
                let is_changed = previous.bandwidth_gbps != link.bandwidth_gbps
                    || previous.link_type != link.link_type;
                if is_changed {
                    changed.push(LinkChange {
                        pubkey: link.pubkey.clone(),
                        contributor_code: link.contributor_code.clone(),
                        side_a_code: link.side_a_code.clone(),
                        side_z_code: link.side_z_code.clone(),
                        before: LinkAttrs {
                            bandwidth_gbps: previous.bandwidth_gbps,
                            link_type: previous.link_type.clone(),
                        },
                        after: LinkAttrs {
                            bandwidth_gbps: link.bandwidth_gbps,
                            link_type: link.link_type.clone(),
                        },
                    });
                }
            }
        }
    }
    let removed: Vec<LinkRef> = before
        .links
        .iter()
        .filter(owned)
        .filter(|link| !after_links.contains_key(link.pubkey.as_str()))
        .cloned()
        .collect();

    let previous = before.contributors.iter().find(|c| c.code == code);
    let next = after.contributors.iter().find(|c| c.code == code);
    let bandwidth_gbps_before = sum_bandwidth(&before.links, code);
    let bandwidth_gbps_after = sum_bandwidth(&after.links, code);

    ContributorDiffResponse {
        code: code.to_string(),
        from: before.epoch,
        to: after.epoch,
        summary: ContributorDiffSummary {
            links_added: count_u32(added.len()),
            links_removed: count_u32(removed.len()),
            links_changed: count_u32(changed.len()),
            bandwidth_gbps_before,
            bandwidth_gbps_after,
            bandwidth_gbps_delta: bandwidth_gbps_after - bandwidth_gbps_before,
        },
        footprint: ContributorFootprint {
            before: footprint_counts(previous),
            after: footprint_counts(next),
            first_seen: previous.is_none() && next.is_some(),
            left_network: previous.is_some() && next.is_none(),
        },
        added,
        removed,
        changed,
        fetched_at,
    }
}

/// Current time as RFC 3339 text, the `fetchedAt` format the UI expects.
pub fn now_rfc3339() -> String {
    DateTime::from(SystemTime::now())
        .fmt(DateTimeFormat::DateTime)
        // Formatting fails only for years outside 0..=9999, which the system clock cannot produce.
        .unwrap_or_else(|_| UNIX_EPOCH_RFC3339.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(
        pubkey: &str,
        code: &str,
        side_a: &str,
        side_z: &str,
        gbps: f64,
        kind: &str,
    ) -> LinkRef {
        LinkRef {
            pubkey: pubkey.to_string(),
            contributor_code: code.to_string(),
            side_a_code: side_a.to_string(),
            side_z_code: side_z.to_string(),
            bandwidth_gbps: gbps,
            link_type: kind.to_string(),
        }
    }

    fn contributor(code: &str, links: u32, devices: u32, metros: u32) -> ContributorRef {
        ContributorRef {
            code: code.to_string(),
            link_count: links,
            device_count: devices,
            metro_count: metros,
        }
    }

    fn shape_before() -> DiffShape {
        DiffShape {
            epoch: Epoch(148),
            links: vec![
                link("K1", "alpha", "nyc", "lon", 10.0, "WAN"),
                link("K2", "beta", "lon", "fra", 100.0, "WAN"),
            ],
            contributors: vec![contributor("alpha", 1, 2, 2), contributor("beta", 1, 1, 1)],
        }
    }

    fn shape_after() -> DiffShape {
        DiffShape {
            epoch: Epoch(149),
            links: vec![
                link("K1", "alpha", "nyc", "fra", 20.0, "WAN"),
                link("K4", "beta", "fra", "nyc", 10.0, "WAN"),
            ],
            contributors: vec![
                contributor("alpha", 1, 2, 2),
                contributor("beta", 1, 1, 1),
                contributor("gamma", 0, 0, 0),
            ],
        }
    }

    fn scan_result(sections: &[(&'static str, &str)]) -> ScanResult {
        ScanResult {
            epoch: Epoch(7),
            sections: sections
                .iter()
                .map(|(key, text)| (*key, text.as_bytes().to_vec()))
                .collect(),
            bytes_read: 1,
            is_cancelled_early: true,
        }
    }

    #[test]
    fn ordered_map_keeps_file_order_and_rejects_non_objects() {
        let parsed: OrderedMap<serde_json::Value> =
            serde_json::from_str(r#"{"zeta": 1, "alpha": 2, "mid": 3}"#).unwrap();
        let keys: Vec<&str> = parsed.0.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(keys, ["zeta", "alpha", "mid"]);

        assert!(serde_json::from_str::<OrderedMap<serde_json::Value>>("[1, 2]").is_err());
        assert!(serde_json::from_str::<OrderedMap<serde_json::Value>>("null").is_err());
    }

    #[test]
    fn parse_sections_reads_records_and_reports_malformed_sections() {
        let scan = scan_result(&[
            (
                "locations",
                r#"{"L1": {"code": "nyc", "name": "New York"}}"#,
            ),
            (
                "devices",
                r#"{"D1": {"location_pk": "L1", "contributor_pk": "C1", "extra": 1}}"#,
            ),
            (
                "links",
                r#"{"K1": {"side_a_pk": "D1", "side_z_pk": "D1", "link_type": "WAN", "bandwidth": 10000000000, "contributor_pk": "C1"}}"#,
            ),
            ("contributors", r#"{"C1": {"code": "alpha"}}"#),
        ]);
        let sections = parse_sections(&scan).unwrap();
        assert_eq!(sections.links.0[0].1.bandwidth, 10e9);
        let shape = extract_diff_shape(Epoch(7), &sections);
        assert_eq!(shape.links[0].side_a_code, "nyc");
        assert_eq!(shape.contributors[0], contributor("alpha", 1, 1, 1));

        let bad = scan_result(&[
            ("locations", "{}"),
            ("devices", "{}"),
            ("links", r#"{"K1": {"side_a_pk": "D1"}}"#),
            ("contributors", "{}"),
        ]);
        let error = parse_sections(&bad).unwrap_err();
        assert!(matches!(
            error,
            SnapshotError::Scan {
                failure: ScanFailure::Malformed(_),
                ..
            }
        ));

        let scalar = scan_result(&[
            ("locations", "{}"),
            ("devices", "{}"),
            ("links", " null"),
            ("contributors", "{}"),
        ]);
        assert!(matches!(
            parse_sections(&scalar).unwrap_err(),
            SnapshotError::Scan {
                failure: ScanFailure::SectionNotObject("links"),
                ..
            }
        ));

        let incomplete = scan_result(&[("locations", "{}")]);
        assert!(matches!(
            parse_sections(&incomplete).unwrap_err(),
            SnapshotError::Scan {
                failure: ScanFailure::MissingSection("devices"),
                ..
            }
        ));
    }

    #[test]
    fn extract_diff_shape_resolves_codes_and_counts() {
        let sections = DiffSections {
            locations: OrderedMap(vec![
                ("L1".into(), RawLocation { code: "nyc".into() }),
                ("L2".into(), RawLocation { code: "lon".into() }),
            ]),
            devices: OrderedMap(vec![
                (
                    "D1".into(),
                    RawDevice {
                        location_pk: "L1".into(),
                        contributor_pk: "C1".into(),
                    },
                ),
                (
                    "D2".into(),
                    RawDevice {
                        location_pk: "L2".into(),
                        contributor_pk: "C1".into(),
                    },
                ),
                (
                    "D3".into(),
                    RawDevice {
                        location_pk: "LX".into(),
                        contributor_pk: "CX".into(),
                    },
                ),
            ]),
            links: OrderedMap(vec![
                (
                    "K1".into(),
                    RawLink {
                        side_a_pk: "D1".into(),
                        side_z_pk: "D2".into(),
                        link_type: "WAN".into(),
                        bandwidth: 10e9,
                        contributor_pk: "C1".into(),
                    },
                ),
                (
                    "K5".into(),
                    RawLink {
                        side_a_pk: "D3".into(),
                        side_z_pk: "D1".into(),
                        link_type: "WAN".into(),
                        bandwidth: 1e9,
                        contributor_pk: "CX".into(),
                    },
                ),
            ]),
            contributors: OrderedMap(vec![(
                "C1".into(),
                RawContributor {
                    code: "alpha".into(),
                },
            )]),
        };
        let shape = extract_diff_shape(Epoch(148), &sections);
        assert_eq!(shape.epoch, Epoch(148));
        assert_eq!(
            shape.links[0],
            link("K1", "alpha", "nyc", "lon", 10.0, "WAN")
        );
        assert_eq!(shape.links[1], link("K5", "unknown", "", "nyc", 1.0, "WAN"));
        assert_eq!(shape.contributors, vec![contributor("alpha", 1, 2, 2)]);
    }

    #[test]
    fn validate_window_emits_the_three_route_messages() {
        assert_eq!(
            validate_window(Some("1"), Some("2")),
            Err(WINDOW_BOUNDS_MESSAGE)
        );
        assert_eq!(
            validate_window(Some("48"), Some("49")),
            Ok(EpochWindow {
                from: Epoch(48),
                to: Epoch(49)
            })
        );
        assert_eq!(
            validate_window(Some("48"), Some("300")),
            Err(WINDOW_TOO_WIDE_MESSAGE)
        );
        assert_eq!(
            validate_window(Some("x"), Some("2")),
            Err(WINDOW_REQUIRED_MESSAGE)
        );
        assert_eq!(
            validate_window(None, Some("2")),
            Err(WINDOW_REQUIRED_MESSAGE)
        );
        assert_eq!(
            validate_window(Some("50"), Some("50")),
            Err(WINDOW_REQUIRED_MESSAGE)
        );
        assert_eq!(
            validate_window(Some("100000"), Some("99900")).unwrap().from,
            MAX_DIFF_EPOCH
        );
        assert_eq!(
            WINDOW_BOUNDS_MESSAGE,
            format!(
                "from and to must be in [{}, {}]",
                MIN_DZ_EPOCH.0, MAX_DIFF_EPOCH.0
            )
        );
        assert_eq!(
            WINDOW_TOO_WIDE_MESSAGE,
            format!("epoch window too wide: |to - from| must be <= {MAX_DIFF_WINDOW}")
        );
    }

    #[test]
    fn network_diff_orders_entries_and_attributes_to_intermediates() {
        let before = shape_before();
        let after = shape_after();
        let response = compute_network_diff(&before, &after, &[], "now".to_string());

        assert_eq!(response.from, Epoch(148));
        assert_eq!(response.to, Epoch(149));
        assert_eq!(response.added.len(), 1);
        assert_eq!(response.added[0].link.pubkey, "K4");
        assert_eq!(response.removed[0].link.pubkey, "K2");
        let fields: Vec<ChangedField> = response.changed.iter().map(|entry| entry.field).collect();
        assert_eq!(
            fields,
            [ChangedField::BandwidthGbps, ChangedField::Endpoint]
        );
        assert_eq!(response.changed[0].before, FieldValue::Number(10.0));
        assert_eq!(
            response.changed[1].after,
            FieldValue::Text("nyc↔fra".to_string())
        );
        assert!(
            response
                .changed
                .iter()
                .all(|entry| entry.first_observed_epoch == Epoch(149))
        );

        let codes: Vec<&str> = response
            .contributors
            .iter()
            .map(|row| row.code.as_str())
            .collect();
        assert_eq!(codes, ["beta", "alpha", "gamma"]);
        assert_eq!(response.contributors[0].bandwidth_gbps_delta, -90.0);
        assert!(response.contributors[2].first_seen);
        assert_eq!(response.summary.contributors_affected, 3);
        assert_eq!(response.fetched_at, "now");

        let mut later = shape_after();
        later.epoch = Epoch(150);
        let attributed =
            compute_network_diff(&before, &later, &[Arc::new(after)], "now".to_string());
        assert!(
            attributed
                .added
                .iter()
                .all(|entry| entry.first_observed_epoch == Epoch(149))
        );
        assert!(
            attributed
                .removed
                .iter()
                .all(|entry| entry.first_observed_epoch == Epoch(149))
        );
        assert!(
            attributed
                .changed
                .iter()
                .all(|entry| entry.first_observed_epoch == Epoch(149))
        );

        let json = serde_json::to_value(&attributed).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert!(keys.contains(&&"fetchedAt".to_string()));
        assert_eq!(json["added"][0]["firstObservedEpoch"], 149);
        assert_eq!(json["changed"][0]["field"], "bandwidthGbps");
    }

    #[test]
    fn network_diff_of_identical_shapes_is_empty() {
        let shape = shape_before();
        let response = compute_network_diff(&shape, &shape, &[], String::new());
        assert!(response.added.is_empty());
        assert!(response.removed.is_empty());
        assert!(response.changed.is_empty());
        assert!(response.contributors.is_empty());
    }

    #[test]
    fn contributor_diff_scopes_to_the_code() {
        let before = shape_before();
        let after = shape_after();
        let alpha = compute_contributor_diff(&before, &after, "alpha", "now".to_string());
        assert_eq!(alpha.summary.links_changed, 1);
        assert_eq!(alpha.changed[0].before.bandwidth_gbps, 10.0);
        assert_eq!(alpha.changed[0].after.bandwidth_gbps, 20.0);
        assert_eq!(alpha.summary.bandwidth_gbps_delta, 10.0);
        assert!(!alpha.footprint.first_seen);

        let beta = compute_contributor_diff(&before, &after, "beta", "now".to_string());
        assert_eq!(beta.added[0].pubkey, "K4");
        assert_eq!(beta.removed[0].pubkey, "K2");
        assert!(beta.changed.is_empty());

        let gamma = compute_contributor_diff(&before, &after, "gamma", "now".to_string());
        assert!(gamma.footprint.first_seen);
        assert_eq!(gamma.footprint.before, footprint_counts(None));

        let reversed = compute_contributor_diff(&after, &before, "beta", "now".to_string());
        assert_eq!(reversed.added[0].pubkey, "K2");
        assert_eq!(reversed.removed[0].pubkey, "K4");

        let json = serde_json::to_value(&gamma).unwrap();
        assert!(json.get("name").is_none());
        assert_eq!(json["footprint"]["firstSeen"], true);
    }

    #[test]
    fn now_rfc3339_is_utc_with_a_date_and_time() {
        let now = now_rfc3339();
        assert!(now.ends_with('Z'));
        assert_eq!(now.matches('T').count(), 1);
        assert!(now.starts_with("20"));
    }

    #[test]
    fn count_u32_saturates() {
        assert_eq!(count_u32(3), 3);
        assert_eq!(count_u32(usize::MAX), u32::MAX);
    }
}
