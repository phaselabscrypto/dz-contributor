/**
 * Per-epoch diff record extraction.
 *
 * Restored from `lib/utils/snapshot-diff.ts`, which PR 23 replaced with a
 * byte-level scanner in the Rust service. The scanner is gone again: it only
 * worked because the diff needs the first 3.7 MB of a snapshot, while the
 * canonical Shapley input needs both ends of the file, so the cron has to
 * download the whole thing anyway. Extracting here costs one pass over an
 * object already in memory.
 *
 * Field names are the wire contract shared with `DiffShape` in
 * `services/shapley-rs/src/diff.rs`; the two must change together, and
 * `DIFF_SHAPE_VERSION_PREFIX` in `diff_store.rs` must be bumped when they do.
 *
 * Record ORDER is part of the contract. The diff reports entries in snapshot
 * file order and `tests/fixtures/diff/*.json` pins it. `Object.entries`
 * preserves insertion order here because every key is a base58 pubkey and no
 * base58 string parses as an array index, which is what makes this match the
 * `OrderedMap` the Rust extractor used.
 */

import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ContributorRef, DiffShapeRecord, LinkRef } from "@/lib/types/diff";

/** Contributor code used when a device or link names an unknown owner. */
const UNKNOWN_CONTRIBUTOR_CODE = "unknown";
/** Snapshot bandwidth is bps; the wire contract is Gbps. */
const BPS_PER_GBPS = 1e9;

/**
 * Project one raw snapshot onto the record the diff routes serve from.
 *
 * Reads only `dz_serviceability.{locations, devices, links, contributors}`.
 * Ignores the telemetry arrays entirely, which are ~97 MB of the ~110 MB file.
 */
export function extractDiffShape(raw: RawSnapshot): DiffShapeRecord {
  const svc = raw.fetch_data.dz_serviceability;

  // pubkey → location code.
  const locationCode = new Map<string, string>();
  for (const [pk, loc] of Object.entries(svc.locations)) {
    locationCode.set(pk, loc.code);
  }

  // pubkey → contributor code.
  const contributorCode = new Map<string, string>();
  for (const [pk, c] of Object.entries(svc.contributors)) {
    contributorCode.set(pk, c.code);
  }

  // pubkey → device location code (resolves location codes for
  // side_a/side_z link endpoints). Also tracks per-contributor device
  // counts + metro fingerprint for the contributor footprint stats.
  const deviceLocationCode = new Map<string, string>();
  const devicesByContributor = new Map<string, number>();
  const metrosByContributor = new Map<string, Set<string>>();

  for (const [pk, d] of Object.entries(svc.devices)) {
    const locCode = locationCode.get(d.location_pk) ?? "";
    deviceLocationCode.set(pk, locCode);

    const contribCode = contributorCode.get(d.contributor_pk) ?? UNKNOWN_CONTRIBUTOR_CODE;

    devicesByContributor.set(
      contribCode,
      (devicesByContributor.get(contribCode) ?? 0) + 1,
    );

    if (locCode) {
      const set = metrosByContributor.get(contribCode) ?? new Set<string>();
      set.add(locCode);
      metrosByContributor.set(contribCode, set);
    }
  }

  // Link extraction. Raw bandwidth is bps; convert to Gbps for display.
  const links: LinkRef[] = [];
  const linksByContributor = new Map<string, number>();

  for (const [pk, l] of Object.entries(svc.links)) {
    const contribCode = contributorCode.get(l.contributor_pk) ?? UNKNOWN_CONTRIBUTOR_CODE;
    links.push({
      pubkey: pk,
      contributorCode: contribCode,
      sideACode: deviceLocationCode.get(l.side_a_pk) ?? "",
      sideZCode: deviceLocationCode.get(l.side_z_pk) ?? "",
      bandwidthGbps: l.bandwidth / BPS_PER_GBPS,
      linkType: l.link_type,
    });
    linksByContributor.set(
      contribCode,
      (linksByContributor.get(contribCode) ?? 0) + 1,
    );
  }

  // Contributor footprint stats.
  const contributors: ContributorRef[] = [];
  for (const c of Object.values(svc.contributors)) {
    contributors.push({
      code: c.code,
      linkCount: linksByContributor.get(c.code) ?? 0,
      deviceCount: devicesByContributor.get(c.code) ?? 0,
      metroCount: metrosByContributor.get(c.code)?.size ?? 0,
    });
  }

  return { epoch: raw.dz_epoch, links, contributors };
}
