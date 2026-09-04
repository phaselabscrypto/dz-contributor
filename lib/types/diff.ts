/**
 * Wire types for `/api/diff` and `/api/diff/contributor/[code]`.
 *
 * These mirror the `#[serde(rename_all = "camelCase")]` structs in
 * `services/shapley-rs/src/diff.rs` and must change together.
 */

/** One link as it appears in a snapshot's lean diff shape. */
export interface LinkRef {
  pubkey: string;
  contributorCode: string;
  sideACode: string;
  sideZCode: string;
  bandwidthGbps: number;
  linkType: string;
}

/** Per-contributor footprint counts for one epoch. */
export interface ContributorRef {
  code: string;
  linkCount: number;
  deviceCount: number;
  metroCount: number;
}

/** A link plus the first epoch in (from, to] where its state was observed. */
export interface AttributedLinkRef extends LinkRef {
  firstObservedEpoch: number;
}

/** The link fields the network diff tracks individually. */
export type DiffChangedField = "bandwidthGbps" | "linkType" | "endpoint";

/** One changed field on one link; `endpoint` values are `"a↔z"` strings. */
export interface ChangedEntry {
  pubkey: string;
  contributorCode: string;
  field: DiffChangedField;
  before: number | string;
  after: number | string;
  firstObservedEpoch: number;
}

/** Network-wide counts for a diff window. */
export interface NetworkDiffSummary {
  linksAdded: number;
  linksRemoved: number;
  linksChanged: number;
  contributorsAffected: number;
}

/** Per-contributor rollup row in the network diff. */
export interface ContributorRollupRow {
  code: string;
  beforeLinkCount: number;
  afterLinkCount: number;
  beforeDeviceCount: number;
  afterDeviceCount: number;
  beforeMetroCount: number;
  afterMetroCount: number;
  linksAdded: number;
  linksRemoved: number;
  linksChanged: number;
  bandwidthGbpsBefore: number;
  bandwidthGbpsAfter: number;
  bandwidthGbpsDelta: number;
  firstSeen: boolean;
  leftNetwork: boolean;
}

/** Body of `GET /api/diff?from&to`. */
export interface NetworkDiffResponse {
  from: number;
  to: number;
  summary: NetworkDiffSummary;
  contributors: ContributorRollupRow[];
  added: AttributedLinkRef[];
  removed: AttributedLinkRef[];
  changed: ChangedEntry[];
  fetchedAt: string;
}

/** The two mutable link attributes compared by the contributor diff. */
export interface LinkAttrs {
  bandwidthGbps: number;
  linkType: string;
}

/** One link whose attributes changed between the two epochs. */
export interface LinkChange {
  pubkey: string;
  contributorCode: string;
  sideACode: string;
  sideZCode: string;
  before: LinkAttrs;
  after: LinkAttrs;
}

/** Footprint counts for one side of the contributor diff. */
export interface FootprintCounts {
  linkCount: number;
  deviceCount: number;
  metroCount: number;
}

/** Before/after footprint plus presence flags for one contributor. */
export interface ContributorFootprint {
  before: FootprintCounts;
  after: FootprintCounts;
  firstSeen: boolean;
  leftNetwork: boolean;
}

/** Counts and bandwidth totals for one contributor's diff window. */
export interface ContributorDiffSummary {
  linksAdded: number;
  linksRemoved: number;
  linksChanged: number;
  bandwidthGbpsBefore: number;
  bandwidthGbpsAfter: number;
  bandwidthGbpsDelta: number;
}

/**
 * Body of `GET /api/diff/contributor/[code]?from&to`. The Rust service
 * omits `name`; the Next.js proxy adds it from `CONTRIBUTOR_NAMES`.
 */
export interface ContributorDiffResponse {
  code: string;
  name: string;
  from: number;
  to: number;
  summary: ContributorDiffSummary;
  footprint: ContributorFootprint;
  added: LinkRef[];
  removed: LinkRef[];
  changed: LinkChange[];
  fetchedAt: string;
}

/**
 * One epoch's extracted diff record, the wire body of
 * `PUT {service}/diff/shape/:epoch`.
 *
 * Mirrors `DiffShape` in `services/shapley-rs/src/diff.rs`. The Rust side
 * deserializes into a struct, so field ORDER does not matter, but the order of
 * `links` and `contributors` does: the diff reports entries in file order and
 * `tests/fixtures/diff/*.json` pins it.
 */
export interface DiffShapeRecord {
  epoch: number;
  links: LinkRef[];
  contributors: ContributorRef[];
}
