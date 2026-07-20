import { NextResponse } from "next/server";
import {
  fetchAndParseForDiff,
  publicDiffFetchError,
  type LinkRef as DiffLinkRef,
} from "@/lib/utils/snapshot-diff";
import { getSnapshotUrl } from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { reportError } from "@/lib/observability";
import { LruCache } from "@/lib/utils/lru-cache";

/**
 * GET /api/diff?from=<epoch>&to=<epoch>
 *
 * Compares two parsed snapshots and reports per-contributor + per-link
 * changes. Each added/removed/changed entry is attributed to the
 * earliest intermediate epoch in (from, to] where it was first
 * observable — so users can pinpoint which epoch a change shipped in,
 * not just the comparison window.
 *
 * Intermediate snapshots are fetched in parallel with a small
 * concurrency cap to avoid hammering S3. Cached for 30 minutes; the
 * underlying snapshots are immutable.
 */

// Diff payloads are small (~50KB) but each one references a (from,to)
// pair so the keyspace can blow up. Cap at 16 to keep memory bounded.
const cache = new LruCache<string, unknown>({
  ttlMs: 30 * 60 * 1000,
  maxSize: 16,
});

/** Diff-route view of a link — extends the shared DiffLinkRef with an
 *  attribution-walker field. */
interface LinkRef extends DiffLinkRef {
  /** Earliest intermediate epoch in (from, to] where this link first
   *  appeared / disappeared / took its new value. Populated by the
   *  attribution walker. Defaults to `to` if no intermediates are
   *  available (e.g. comparing adjacent epochs). */
  firstObservedEpoch?: number;
}


/** Fetch a list of epochs in parallel with a concurrency cap. Returns
 *  results keyed by epoch. Failures are logged and dropped — the
 *  attribution walker tolerates gaps. */
async function fetchEpochsChunked(
  epochs: number[],
  concurrency = 10,
): Promise<Map<number, Awaited<ReturnType<typeof fetchAndParse>>>> {
  const out = new Map<number, Awaited<ReturnType<typeof fetchAndParse>>>();
  const queue = [...epochs];
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, queue.length); w++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const ep = queue.shift();
          if (ep === undefined) return;
          try {
            const parsed = await fetchAndParse(ep);
            out.set(ep, parsed);
          } catch (err) {
            // Snapshot may have been pruned or unavailable. Skip it —
            // attribution falls back to neighbour epochs. We still log
            // via reportError so the missing-snapshot pattern surfaces
            // in observability (#19 no-silent-fallback rule); the diff
            // route itself tolerates the gap by design.
            reportError(err, {
              source: "api/diff#fetchEpochsChunked",
              extras: { epoch: ep },
            });
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

// Defers to the shared lean extractor: the full parseSnapshot() pipeline
// loads telemetry, leader schedule, and demand scores the diff never reads.
async function fetchAndParse(epoch: number) {
  return fetchAndParseForDiff(epoch);
}

// Epoch-range validation bounds. DZ epochs start at 48 (earliest published
// snapshot). The upper bound is intentionally generous — we let the S3 fetch
// itself 404 for "epoch doesn't exist yet" rather than baking in a ceiling
// that goes stale. The range cap exists only to prevent a
// pathological window (e.g. `?from=1&to=99999`) from triggering 90k+ HEAD
// probes during the intermediate-epoch walk.
const MIN_DIFF_EPOCH = 48;
const MAX_DIFF_EPOCH = 100_000;
const MAX_DIFF_WINDOW = 200;

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, {
    bucket: "diff",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;

  const url = new URL(request.url);
  const from = parseInt(url.searchParams.get("from") ?? "", 10);
  const to = parseInt(url.searchParams.get("to") ?? "", 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
    return NextResponse.json(
      { error: "from and to query params required (different integers)" },
      { status: 400 },
    );
  }
  if (
    from < MIN_DIFF_EPOCH ||
    to < MIN_DIFF_EPOCH ||
    from > MAX_DIFF_EPOCH ||
    to > MAX_DIFF_EPOCH
  ) {
    return NextResponse.json(
      {
        error: `from and to must be in [${MIN_DIFF_EPOCH}, ${MAX_DIFF_EPOCH}]`,
      },
      { status: 400 },
    );
  }
  if (Math.abs(to - from) > MAX_DIFF_WINDOW) {
    return NextResponse.json(
      {
        error: `epoch window too wide: |to - from| must be <= ${MAX_DIFF_WINDOW}`,
      },
      { status: 400 },
    );
  }

  const cacheKey = `${from}->${to}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return NextResponse.json(cached);
  }

  let a, b;
  try {
    [a, b] = await Promise.all([fetchAndParse(from), fetchAndParse(to)]);
  } catch (err) {
    reportError(err, { source: "api/diff", extras: { from, to } });
    return NextResponse.json(
      { error: publicDiffFetchError(err) },
      { status: 502 },
    );
  }

  const aLinks = new Map(a.links.map((l) => [l.pubkey, l]));
  const bLinks = new Map(b.links.map((l) => [l.pubkey, l]));

  const added: LinkRef[] = [];
  const removed: LinkRef[] = [];
  interface ChangedEntry {
    pubkey: string;
    contributorCode: string;
    field: "bandwidthGbps" | "linkType" | "endpoint";
    before: unknown;
    after: unknown;
    firstObservedEpoch?: number;
  }
  const changed: ChangedEntry[] = [];

  for (const [pk, link] of bLinks) {
    if (!aLinks.has(pk)) added.push(link);
    else {
      const prev = aLinks.get(pk)!;
      if (prev.bandwidthGbps !== link.bandwidthGbps) {
        changed.push({
          pubkey: pk,
          contributorCode: link.contributorCode,
          field: "bandwidthGbps",
          before: prev.bandwidthGbps,
          after: link.bandwidthGbps,
        });
      }
      if (prev.linkType !== link.linkType) {
        changed.push({
          pubkey: pk,
          contributorCode: link.contributorCode,
          field: "linkType",
          before: prev.linkType,
          after: link.linkType,
        });
      }
      if (prev.sideACode !== link.sideACode || prev.sideZCode !== link.sideZCode) {
        changed.push({
          pubkey: pk,
          contributorCode: link.contributorCode,
          field: "endpoint",
          before: `${prev.sideACode}↔${prev.sideZCode}`,
          after: `${link.sideACode}↔${link.sideZCode}`,
        });
      }
    }
  }
  for (const [pk, link] of aLinks) {
    if (!bLinks.has(pk)) removed.push(link);
  }

  // ---------------------------------------------------------------
  // Attribute each entry to its first-observed epoch in (from, to].
  //
  // Without this walk, every change in a wide diff gets stamped with
  // `to`, which lies about when the change actually shipped. We fetch
  // every intermediate snapshot (bounded by S3 availability) and find
  // the earliest epoch where each added/removed/changed link appears
  // in its new state.
  //
  // Skips the walk entirely when from + 1 === to (no intermediates).
  // Falls back to `to` for any entry the walker can't pin down (e.g.
  // intermediate snapshot pruned by S3).
  // ---------------------------------------------------------------
  if (to - from > 1 && (added.length || removed.length || changed.length)) {
    const intermediates: number[] = [];
    for (let e = from + 1; e <= to; e++) intermediates.push(e);
    const snapshots = await fetchEpochsChunked(intermediates);

    // Sort epochs ascending so the first match wins.
    const orderedEpochs = [...snapshots.keys()].sort((x, y) => x - y);

    // Build a pubkey→link Map per snapshot ONCE so the attribution
    // lookups below are O(1) per check instead of O(N=links/epoch).
    // For 20 intermediates × 200 changes × 500 links/epoch, that's the
    // difference between 2M ops and 4k ops.
    const linkIndexByEpoch = new Map<number, Map<string, DiffLinkRef>>();
    for (const e of orderedEpochs) {
      const snap = snapshots.get(e)!;
      const idx = new Map<string, DiffLinkRef>();
      for (const l of snap.links) idx.set(l.pubkey, l);
      linkIndexByEpoch.set(e, idx);
    }

    // ADDED: first epoch where the link's pubkey appears.
    for (const link of added) {
      for (const e of orderedEpochs) {
        if (linkIndexByEpoch.get(e)!.has(link.pubkey)) {
          link.firstObservedEpoch = e;
          break;
        }
      }
      if (link.firstObservedEpoch === undefined) link.firstObservedEpoch = to;
    }

    // REMOVED: first epoch where the link's pubkey is absent (i.e.
    // the epoch the removal landed in).
    for (const link of removed) {
      for (const e of orderedEpochs) {
        if (!linkIndexByEpoch.get(e)!.has(link.pubkey)) {
          link.firstObservedEpoch = e;
          break;
        }
      }
      if (link.firstObservedEpoch === undefined) link.firstObservedEpoch = to;
    }

    // CHANGED: first epoch where the link's tracked field matches the
    // new value. Each field has its own comparator.
    for (const entry of changed) {
      for (const e of orderedEpochs) {
        const hit = linkIndexByEpoch.get(e)!.get(entry.pubkey);
        if (!hit) continue;
        const matchesAfter =
          entry.field === "bandwidthGbps"
            ? hit.bandwidthGbps === entry.after
            : entry.field === "linkType"
              ? hit.linkType === entry.after
              : `${hit.sideACode}↔${hit.sideZCode}` === entry.after;
        if (matchesAfter) {
          entry.firstObservedEpoch = e;
          break;
        }
      }
      if (entry.firstObservedEpoch === undefined) entry.firstObservedEpoch = to;
    }
  } else {
    // Adjacent epochs (from + 1 === to): every change happened in `to`.
    for (const link of added) link.firstObservedEpoch = to;
    for (const link of removed) link.firstObservedEpoch = to;
    for (const entry of changed) entry.firstObservedEpoch = to;
  }

  // Per-contributor rollup
  const allCodes = new Set<string>();
  const aByCode = new Map(a.contributors.map((c) => [c.code, c]));
  const bByCode = new Map(b.contributors.map((c) => [c.code, c]));
  for (const c of a.contributors) allCodes.add(c.code);
  for (const c of b.contributors) allCodes.add(c.code);

  const contributorRollup = [...allCodes]
    .map((code) => {
      const before = aByCode.get(code);
      const after = bByCode.get(code);
      const linksAdded = added.filter((l) => l.contributorCode === code).length;
      const linksRemoved = removed.filter((l) => l.contributorCode === code)
        .length;
      const linksChanged = changed.filter((l) => l.contributorCode === code)
        .length;
      const bwBefore =
        before && a.links
          ? a.links
              .filter((l) => l.contributorCode === code)
              .reduce((s, l) => s + l.bandwidthGbps, 0)
          : 0;
      const bwAfter =
        after && b.links
          ? b.links
              .filter((l) => l.contributorCode === code)
              .reduce((s, l) => s + l.bandwidthGbps, 0)
          : 0;
      return {
        code,
        beforeLinkCount: before?.linkCount ?? 0,
        afterLinkCount: after?.linkCount ?? 0,
        beforeDeviceCount: before?.deviceCount ?? 0,
        afterDeviceCount: after?.deviceCount ?? 0,
        beforeMetroCount: before?.metroCount ?? 0,
        afterMetroCount: after?.metroCount ?? 0,
        linksAdded,
        linksRemoved,
        linksChanged,
        bandwidthGbpsBefore: bwBefore,
        bandwidthGbpsAfter: bwAfter,
        bandwidthGbpsDelta: bwAfter - bwBefore,
        firstSeen: !before && !!after,
        leftNetwork: !!before && !after,
      };
    })
    .filter(
      (c) =>
        c.linksAdded > 0 ||
        c.linksRemoved > 0 ||
        c.linksChanged > 0 ||
        c.firstSeen ||
        c.leftNetwork,
    )
    .sort(
      (x, y) =>
        Math.abs(y.bandwidthGbpsDelta) - Math.abs(x.bandwidthGbpsDelta) ||
        y.linksAdded + y.linksRemoved - (x.linksAdded + x.linksRemoved),
    );

  const data = {
    from: a.epoch,
    to: b.epoch,
    summary: {
      linksAdded: added.length,
      linksRemoved: removed.length,
      linksChanged: changed.length,
      contributorsAffected: contributorRollup.length,
    },
    contributors: contributorRollup,
    added,
    removed,
    changed,
    fetchedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, data);
  return NextResponse.json(data);
}
