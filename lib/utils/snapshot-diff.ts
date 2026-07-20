/**
 * Shared snapshot-diff computation. Used by /api/diff (network-wide)
 * and /api/diff/contributor/[code] (operator-scoped).
 *
 * Extracts only the fields the diff needs directly from the raw snapshot,
 * skipping the full `parseSnapshot()` pipeline — the parser hydrates
 * telemetry samples, leader schedule, device demand scores, and full
 * location/exchange records, none of which the diff route reads.
 *
 * Long-term, a `link_events` table indexed on epoch + pubkey (populated
 * by a per-epoch ingest cron job) would replace per-request snapshot walks.
 */

import { getSnapshotUrl } from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";

export interface LinkRef {
  pubkey: string;
  contributorCode: string;
  sideACode: string;
  sideZCode: string;
  bandwidthGbps: number;
  linkType: string;
}

export interface ContributorRef {
  code: string;
  linkCount: number;
  deviceCount: number;
  metroCount: number;
}

export interface ParsedForDiff {
  epoch: number;
  links: LinkRef[];
  contributors: ContributorRef[];
}

/**
 * Lean per-snapshot extraction for the diff pipeline.
 *
 * Reads only:
 *   - svc.contributors (for pubkey → code map)
 *   - svc.locations    (for pubkey → location code map)
 *   - svc.devices      (for pubkey → location code map; counts)
 *   - svc.links        (the actual diff target)
 *
 * Skips entirely:
 *   - dz_telemetry.device_latency_samples (typically tens of MB)
 *   - dz_internet.internet_latency_samples
 *   - leader_schedule
 *   - users / exchanges / metro_prices
 */
export function extractDiffShape(raw: RawSnapshot): ParsedForDiff {
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

    const contribCode = contributorCode.get(d.contributor_pk) ?? "unknown";

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
    const contribCode = contributorCode.get(l.contributor_pk) ?? "unknown";
    links.push({
      pubkey: pk,
      contributorCode: contribCode,
      sideACode: deviceLocationCode.get(l.side_a_pk) ?? "",
      sideZCode: deviceLocationCode.get(l.side_z_pk) ?? "",
      bandwidthGbps: l.bandwidth / 1e9,
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

/**
 * Client-safe message for a failed diff snapshot fetch. The known
 * "epoch N: snapshot HTTP M" shape thrown by {@link fetchAndParseForDiff}
 * is echoed verbatim (it is how the UI reports a missing epoch and names
 * nothing internal); everything else is genericized — unexpected errors
 * can carry hosts or config details that must not reach a public client.
 */
export function publicDiffFetchError(err: unknown): string {
  if (
    err instanceof Error &&
    /^epoch \d+: snapshot HTTP \d+$/.test(err.message)
  ) {
    return err.message;
  }
  return "snapshot fetch failed";
}

export async function fetchAndParseForDiff(
  epoch: number,
): Promise<ParsedForDiff> {
  const res = await fetch(getSnapshotUrl(epoch), {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`epoch ${epoch}: snapshot HTTP ${res.status}`);
  }
  const raw = (await res.json()) as RawSnapshot;
  return extractDiffShape(raw);
}

export interface LinkChange {
  pubkey: string;
  contributorCode: string;
  sideACode: string;
  sideZCode: string;
  before: { bandwidthGbps: number; linkType: string };
  after: { bandwidthGbps: number; linkType: string };
}

export interface DiffResult {
  added: LinkRef[];
  removed: LinkRef[];
  changed: LinkChange[];
}

/**
 * Compute link-level diff between two parsed snapshots.
 * Optionally filter by contributor code.
 */
export function computeDiff(
  a: ParsedForDiff,
  b: ParsedForDiff,
  contributorFilter?: string,
): DiffResult {
  const filter = contributorFilter
    ? (l: LinkRef) => l.contributorCode === contributorFilter
    : () => true;

  const aLinks = new Map(a.links.filter(filter).map((l) => [l.pubkey, l]));
  const bLinks = new Map(b.links.filter(filter).map((l) => [l.pubkey, l]));

  const added: LinkRef[] = [];
  const removed: LinkRef[] = [];
  const changed: LinkChange[] = [];

  for (const [pk, link] of bLinks) {
    if (!aLinks.has(pk)) {
      added.push(link);
    } else {
      const before = aLinks.get(pk)!;
      if (
        before.bandwidthGbps !== link.bandwidthGbps ||
        before.linkType !== link.linkType
      ) {
        changed.push({
          pubkey: pk,
          contributorCode: link.contributorCode,
          sideACode: link.sideACode,
          sideZCode: link.sideZCode,
          before: {
            bandwidthGbps: before.bandwidthGbps,
            linkType: before.linkType,
          },
          after: {
            bandwidthGbps: link.bandwidthGbps,
            linkType: link.linkType,
          },
        });
      }
    }
  }

  for (const [pk, link] of aLinks) {
    if (!bLinks.has(pk)) removed.push(link);
  }

  return { added, removed, changed };
}
