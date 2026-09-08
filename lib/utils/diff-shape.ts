/** Extracts ordered diff records from a validated snapshot. */

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

  const locationCode = new Map<string, string>();
  for (const [pk, loc] of Object.entries(svc.locations)) {
    locationCode.set(pk, loc.code);
  }

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

  // Snapshot insertion order is part of the diff response contract.
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
