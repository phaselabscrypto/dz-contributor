import type { EpochBaseline, ShapleyTracking } from "@/lib/types/baseline";

/**
 * Pivot per-epoch baselines into per-operator share trajectories. `hits` must be
 * ascending by epoch and hold at least two entries; operators come back sorted
 * by their latest share, descending.
 */
export function pivotTracking(
  hits: readonly EpochBaseline[],
): Pick<ShapleyTracking, "method" | "operators"> {
  const allOperators = new Set<string>();
  for (const hit of hits) {
    for (const operator of Object.keys(hit.values)) allOperators.add(operator);
  }

  const operators = [...allOperators].map((operator) => {
    const series = hits.map((hit) => ({
      epoch: hit.epoch,
      share: hit.values[operator]?.share ?? 0,
      value: hit.values[operator]?.value ?? 0,
    }));
    const first = series[0].share;
    const latestShare = series[series.length - 1].share;
    const mean = series.reduce((sum, p) => sum + p.share, 0) / series.length;
    const variance =
      series.reduce((sum, p) => sum + (p.share - mean) ** 2, 0) / series.length;
    return {
      operator,
      series,
      latestShare,
      delta: latestShare - first,
      stdev: Math.sqrt(variance),
    };
  });
  operators.sort((a, b) => b.latestShare - a.latestShare);

  return { method: hits[0].method, operators };
}
