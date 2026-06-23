/**
 * Shared fetcher + parser for the upstream economic-hub feed.
 *
 * Used by both `/api/live/economic-hub` (which serves it to the
 * frontend) and `/api/economics/projection` (which derives forward
 * pool projections from it). Keeping the parsing in one place avoids
 * the self-call HTTP pattern flagged by H10 and gives us a single
 * source of truth for the schema mapping.
 */

import type { EconomicHub, EconomicHubContributor } from "@/lib/types/live";

const UPSTREAM_URL = "https://doublezero.xyz/api/economic-hub";

export async function fetchEconomicHub(): Promise<EconomicHub> {
  const res = await fetch(UPSTREAM_URL, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`economic-hub HTTP ${res.status}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const d = (raw.data as Record<string, unknown>) ?? {};
  const contribs = ((d.contributors as Record<string, unknown>[] | undefined) ?? []).map(
    (c): EconomicHubContributor => ({
      name: String(c.name ?? ""),
      wanLinks: Number(c.wan_links ?? 0),
      dzxLinks: Number(c.dzx_links ?? 0),
      devices: Number(c.devices ?? 0),
      bandwidthBps: Number(c.bandwidth ?? 0),
      totalFiberLength: Number(c.total_fiber_length ?? 0),
      rewardPercentage: Number(c.reward_percentage ?? 0),
    }),
  );
  const epochs = (d.epochs as number[] | undefined) ?? [];
  return {
    epochs,
    currentEpoch: epochs.length > 0 ? Math.max(...epochs) : 0,
    totalSolDebt: Number(d.total_sol_debt ?? 0),
    totalSolDebtUsd: Number(d.total_sol_debt_usd ?? 0),
    total2ZDebt: Number(d.total_2z_debt ?? 0),
    total2ZDebtUsd: Number(d.total_2z_debt_usd ?? 0),
    totalDistributed2Z: Number(d.total_distributed_2z ?? 0),
    totalDistributed2ZUsd: Number(d.total_distributed_2z_usd ?? 0),
    burned2Z: Number(d.burned_2z ?? 0),
    burned2ZUsd: Number(d.burned_2z_usd ?? 0),
    totalWanLinks: Number(d.total_wan_links ?? 0),
    totalDzxLinks: Number(d.total_dzx_links ?? 0),
    totalFiberLength: Number(d.total_fiber_length ?? 0),
    totalBandwidthBps: Number(d.total_bandwidth ?? 0),
    contributors: contribs.sort((a, b) => b.rewardPercentage - a.rewardPercentage),
    updatedAt: String(
      (raw.meta as Record<string, unknown> | undefined)?.updatedAt ??
        new Date().toISOString(),
    ),
  };
}
