import { NextResponse } from "next/server";
import { fetchEconomicHub } from "@/lib/utils/economic-hub-fetch";
import type { EconomicHub } from "@/lib/types/live";
import { reportError } from "@/lib/observability";

/**
 * GET /api/economics/projection?horizon=30
 *
 * Forward-looking pool projection. We don't have per-epoch payout data from
 * upstream (DZ #1, #9 still pending), so the projection uses observable
 * aggregates:
 *   - average distributed 2Z per epoch = totalDistributed2Z / epochs.length
 *   - growth rate inferred from outstanding 2Z debt vs distributed 2Z
 *   - USD anchor from totalDistributed2ZUsd / totalDistributed2Z
 *
 * Returns:
 *   {
 *     horizonEpochs: number,
 *     historicalAvg2ZPerEpoch: number,
 *     historicalAvgUsdPerEpoch: number,
 *     growthRate: number,                // epoch-over-epoch implied growth
 *     projectedEpochs: [
 *       { epochOffset, projected2Z, projectedUsd, cumulative2Z, cumulativeUsd }
 *     ],
 *     methodology: string
 *   }
 *
 * Cached per-horizon for 5 minutes.
 */

// Per-horizon cache, keyed by the horizon param so different `?horizon`
// values never serve each other's data. Bounded by MAX_CACHE_ENTRIES so a
// malicious caller cycling through horizons can't grow the cache without
// bound.
interface CacheEntry {
  data: unknown;
  ts: number;
}
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 32;
const projectionCache = new Map<string, CacheEntry>();

function cacheGet(key: string): unknown {
  const entry = projectionCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts >= CACHE_TTL) {
    projectionCache.delete(key);
    return undefined;
  }
  // Refresh recency for LRU eviction.
  projectionCache.delete(key);
  projectionCache.set(key, entry);
  return entry.data;
}

function cacheSet(key: string, data: unknown): void {
  projectionCache.set(key, { data, ts: Date.now() });
  while (projectionCache.size > MAX_CACHE_ENTRIES) {
    const oldest = projectionCache.keys().next().value;
    if (oldest === undefined) break;
    projectionCache.delete(oldest);
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const horizonRaw = parseInt(url.searchParams.get("horizon") ?? "30", 10);
  if (!Number.isFinite(horizonRaw)) {
    return NextResponse.json(
      { error: "horizon must be an integer" },
      { status: 400 },
    );
  }
  const horizon = Math.max(1, Math.min(horizonRaw || 30, 144));

  const cacheKey = `h:${horizon}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    return NextResponse.json(cached, {
      headers: {
        "Cache-Control":
          "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  }

  let hub;
  try {
    hub = await fetchEconomicHub();
  } catch (err) {
    reportError(err, { source: "api/economics/projection", extras: { horizon } });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const epochCount = hub.epochs.length || 1;
  const historicalAvg2Z = hub.totalDistributed2Z / epochCount;
  const historicalAvgUsd = hub.totalDistributed2ZUsd / epochCount;

  // Implied growth: ratio of outstanding 2Z debt to total distributed gives a
  // crude signal of revenue acceleration. >1 means more is owed than has been
  // paid (network is growing faster than distribution is keeping up). We
  // dampen this aggressively since it's a lagging indicator.
  const debtRatio =
    hub.totalDistributed2Z > 0
      ? hub.total2ZDebt / hub.totalDistributed2Z
      : 0;
  // Cap the inferred growth at +/- 3% per epoch to keep the projection sane
  // until DZ ships per-epoch data we can fit a proper curve to.
  const growthRate = Math.max(-0.03, Math.min(0.03, (debtRatio - 1) * 0.05));

  const projectedEpochs: Array<{
    epochOffset: number;
    projected2Z: number;
    projectedUsd: number;
    cumulative2Z: number;
    cumulativeUsd: number;
  }> = [];

  let cumulative2Z = 0;
  let cumulativeUsd = 0;
  for (let i = 1; i <= horizon; i++) {
    const factor = Math.pow(1 + growthRate, i);
    const projected2Z = historicalAvg2Z * factor;
    const projectedUsd = historicalAvgUsd * factor;
    cumulative2Z += projected2Z;
    cumulativeUsd += projectedUsd;
    projectedEpochs.push({
      epochOffset: i,
      projected2Z,
      projectedUsd,
      cumulative2Z,
      cumulativeUsd,
    });
  }

  const data = {
    horizonEpochs: horizon,
    historicalAvg2ZPerEpoch: historicalAvg2Z,
    historicalAvgUsdPerEpoch: historicalAvgUsd,
    growthRate,
    debtRatio,
    distributedEpochCount: epochCount,
    latestDistributedEpoch: hub.currentEpoch,
    projectedEpochs,
    methodology:
      "Average 2Z per distributed epoch projected forward with a debt-ratio-derived growth factor (capped at +/-3%/epoch). Replace with per-epoch fitted curve once DZ exposes per-epoch contributor payouts (Q9).",
    fetchedAt: new Date().toISOString(),
  };

  cacheSet(cacheKey, data);
  return NextResponse.json(data, {
    headers: {
      "Cache-Control":
        "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
