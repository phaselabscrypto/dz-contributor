import { NextResponse } from "next/server";
import {
  fetchAndParseForDiff,
  computeDiff,
} from "@/lib/utils/snapshot-diff";
import { getContributorDisplayName } from "@/lib/constants/config";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { reportError } from "@/lib/observability";
import { LruCache } from "@/lib/utils/lru-cache";

/**
 * GET /api/diff/contributor/[code]?from=<epoch>&to=<epoch>
 *
 * Returns the same diff shape as /api/diff but scoped to a single
 * contributor — added/removed/changed links plus before/after footprint
 * stats. Drives the per-operator changelog trail on the contributor
 * detail page.
 *
 * Cached for 30 minutes; both inputs are immutable historical snapshots.
 */

// Keyspace is (code × from × to) — multiply that by 14 contributors and
// 30 epochs and the unbounded version could blow up. Cap at 48.
const cache = new LruCache<string, unknown>({
  ttlMs: 30 * 60 * 1000,
  maxSize: 48,
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const limited = enforceRateLimit(request, {
    bucket: "diff-contributor",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;

  const { code } = await params;
  if (!code) {
    return NextResponse.json(
      { error: "contributor code required" },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const from = parseInt(url.searchParams.get("from") ?? "", 10);
  const to = parseInt(url.searchParams.get("to") ?? "", 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
    return NextResponse.json(
      { error: "from and to query params required (different integers)" },
      { status: 400 },
    );
  }

  const cacheKey = `${code}:${from}->${to}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return NextResponse.json(cached);
  }

  let a, b;
  try {
    [a, b] = await Promise.all([
      fetchAndParseForDiff(from),
      fetchAndParseForDiff(to),
    ]);
  } catch (err) {
    reportError(err, { source: "api/diff/contributor", extras: { code, from, to } });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const { added, removed, changed } = computeDiff(a, b, code);

  const before = a.contributors.find((c) => c.code === code);
  const after = b.contributors.find((c) => c.code === code);

  const bwBefore = a.links
    .filter((l) => l.contributorCode === code)
    .reduce((s, l) => s + l.bandwidthGbps, 0);
  const bwAfter = b.links
    .filter((l) => l.contributorCode === code)
    .reduce((s, l) => s + l.bandwidthGbps, 0);

  const data = {
    code,
    name: getContributorDisplayName(code),
    from: a.epoch,
    to: b.epoch,
    summary: {
      linksAdded: added.length,
      linksRemoved: removed.length,
      linksChanged: changed.length,
      bandwidthGbpsBefore: bwBefore,
      bandwidthGbpsAfter: bwAfter,
      bandwidthGbpsDelta: bwAfter - bwBefore,
    },
    footprint: {
      before: {
        linkCount: before?.linkCount ?? 0,
        deviceCount: before?.deviceCount ?? 0,
        metroCount: before?.metroCount ?? 0,
      },
      after: {
        linkCount: after?.linkCount ?? 0,
        deviceCount: after?.deviceCount ?? 0,
        metroCount: after?.metroCount ?? 0,
      },
      firstSeen: !before && !!after,
      leftNetwork: !!before && !after,
    },
    added,
    removed,
    changed,
    fetchedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, data);
  return NextResponse.json(data);
}
