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

/**
 * Live-network Shapley anchor — computes Shapley values against the
 * the LATEST completed epoch's canonical result (DZ-current methodology),
 * served from the shared per-epoch cache and kept warm by the precompute
 * cron — NOT an on-demand live-topology solve. Updates roughly once per
 * epoch (~2-3 days). 5-minute client refresh.
 */
export interface BaselineShapley {
  method: string;
  computedAt: string;
  source: "canonical-latest-epoch";
  epoch: number;
  operatorCount: number;
  values: Record<string, { value: number; share: number }>;
  inputSummary: {
    deviceCount: number;
    privateLinkCount: number;
    publicLinkCount: number;
    demandCount: number;
  };
}

export function useBaselineShapley() {
  return useSWR<BaselineShapley>("/api/shapley/baseline", fetcher, {
    ...swrCfg,
    refreshInterval: 5 * 60_000,
  });
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

export interface ShapleyTrackingPoint {
  epoch: number;
  share: number;
  value: number;
}
export interface ShapleyTrackingOperator {
  operator: string;
  series: ShapleyTrackingPoint[];
  latestShare: number;
  delta: number;
  stdev: number;
}
export interface ShapleyTracking {
  epochs: number[];
  method: string;
  operators: ShapleyTrackingOperator[];
  fetchedAt: string;
  note: string;
}

export function useShapleyTracking(count = 8) {
  return useSWR<ShapleyTracking>(
    `/api/shapley/tracking?count=${count}`,
    fetcher,
    {
      ...swrCfg,
      refreshInterval: 30 * 60_000,
      dedupingInterval: 5 * 60_000,
    },
  );
}
