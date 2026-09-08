"use client";

import useSWR from "swr";
import type {
  LiveTopology,
  LiveStats,
  LiveStatus,
  EconomicHub,
} from "@/lib/types/live";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
};

const swrCfg = {
  revalidateOnFocus: false,
  focusThrottleInterval: 300_000,
  dedupingInterval: 30_000,
  errorRetryInterval: 8_000,
} as const;

export function useLiveTopology() {
  return useSWR<LiveTopology>("/api/live/topology", fetcher, {
    ...swrCfg,
    refreshInterval: 60_000,
  });
}

export function useLiveStats() {
  return useSWR<LiveStats>("/api/live/stats", fetcher, {
    ...swrCfg,
    refreshInterval: 60_000,
  });
}

export function useLiveStatus() {
  return useSWR<LiveStatus>("/api/live/status", fetcher, {
    ...swrCfg,
    refreshInterval: 60_000,
  });
}

export function useEconomicHub() {
  return useSWR<EconomicHub>("/api/live/economic-hub", fetcher, {
    ...swrCfg,
    refreshInterval: 5 * 60_000,
  });
}

// Wire shape lives in lib/types/health.ts (shared with /api/health
// server route so the two can't drift). Re-export for hook consumers.
export type { SourceErrorCode, SourceHealth, HealthAggregate } from "@/lib/types/health";
import type { HealthAggregate } from "@/lib/types/health";

export function useHealth() {
  return useSWR<HealthAggregate>("/api/health", fetcher, {
    ...swrCfg,
    refreshInterval: 30_000,
  });
}

import { isNotCached } from "@/lib/types/baseline";
import type {
  BaselineResponse,
  TrackingResponse,
} from "@/lib/types/baseline";
export type {
  EpochBaseline,
  BaselineResponse,
  ShapleyTracking,
  TrackingResponse,
} from "@/lib/types/baseline";
export {
  cachedBaseline,
  cachedTracking,
  isNotCached,
} from "@/lib/types/baseline";

/**
 * Fetcher for the cache-only baseline routes: a 404 carrying
 * `{status:"not-cached"}` is data (the epoch has no published baseline yet), so
 * SWR keeps it out of `error` and away from the retry storm. Any other non-2xx
 * throws.
 */
async function cacheProbeFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.status === 404) {
    const body: unknown = await res.json().catch(() => null);
    if (isNotCached(body)) return body as T;
    throw new Error(`API ${res.status}`);
  }
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The latest completed epoch's published Shapley baseline. Updates roughly once
 * per epoch (~2-3 days), so a 5-minute client refresh is plenty.
 */
export function useBaselineShapley() {
  return useSWR<BaselineResponse>(
    "/api/shapley/baseline",
    cacheProbeFetcher,
    {
      ...swrCfg,
      refreshInterval: 5 * 60_000,
    },
  );
}

export interface PoolProjection {
  horizonEpochs: number;
  historicalAvg2ZPerEpoch: number;
  historicalAvgUsdPerEpoch: number;
  growthRate: number;
  debtRatio: number;
  distributedEpochCount: number;
  latestDistributedEpoch: number;
  projectedEpochs: Array<{
    epochOffset: number;
    projected2Z: number;
    projectedUsd: number;
    cumulative2Z: number;
    cumulativeUsd: number;
  }>;
  methodology: string;
  fetchedAt: string;
}

export function usePoolProjection(horizon = 30) {
  return useSWR<PoolProjection>(
    `/api/economics/projection?horizon=${horizon}`,
    fetcher,
    { ...swrCfg, refreshInterval: 5 * 60_000 },
  );
}

export function useShapleyTracking(count = 8) {
  return useSWR<TrackingResponse>(
    `/api/shapley/tracking?count=${count}`,
    cacheProbeFetcher,
    {
      ...swrCfg,
      refreshInterval: 30 * 60_000,
      dedupingInterval: 5 * 60_000,
    },
  );
}
