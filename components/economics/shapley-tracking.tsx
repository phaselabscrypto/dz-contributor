"use client";

import { useState } from "react";
import { useShapleyTracking } from "@/lib/hooks/use-live";
import { Sparkline } from "@/components/ui/sparkline";
import { LoadingState, ErrorState } from "@/components/ui/states";
import {
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";
import { Download, ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";

const COUNT_OPTIONS = [4, 8, 12, 16] as const;

/**
 * Per-operator Shapley share trajectories across the latest N snapshots.
 * Renders a small sparkline per operator + delta vs first-in-window so users
 * can spot drift. Replaces the "single-epoch share" view with a stability
 * signal until DZ ships per-epoch on-chain payouts.
 */
export function ShapleyTracking() {
  const [count, setCount] = useState<number>(8);
  const { data, isLoading, error, mutate } = useShapleyTracking(count);

  if (error) {
    return (
      <ErrorState
        title="Couldn't load tracking series"
        message={(error as Error).message}
        onRetry={() => mutate()}
      />
    );
  }
  if (isLoading || !data) {
    return <LoadingState label={`Computing Shapley over last ${count} snapshots`} />;
  }

  const exportCsv = () => {
    const headers = ["Operator", "Display Name", ...data.epochs.map(String), "Δ first→last", "Stdev"];
    const rows = data.operators.map((op) => [
      op.operator,
      getContributorDisplayName(op.operator),
      ...op.series.map((p) => (p.share * 100).toFixed(4)),
      (op.delta * 100).toFixed(4),
      (op.stdev * 100).toFixed(4),
    ]);
    downloadCsv(
      `dz-shapley-tracking-${count}ep-${new Date().toISOString().slice(0, 10)}.csv`,
      rowsToCsv(headers, rows),
    );
  };

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
            Solver tracking
          </span>
          <span className="text-xs text-cream-30 font-mono">
            {data.method}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono">
          <div className="flex items-center gap-1">
            {COUNT_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCount(c)}
                className={`px-2 py-0.5 transition-colors ${
                  count === c
                    ? "text-foreground bg-surface-2"
                    : "text-cream-30 hover:text-foreground"
                }`}
              >
                {c}ep
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Download className="size-3" />
            CSV
          </button>
        </div>
      </div>

      <div className="px-4 py-2 text-xs font-mono text-cream-30 border-b border-border">
        Epochs: {data.epochs.join(" · ")}
      </div>

      <div className="divide-y divide-border">
        {data.operators
          .filter((op) => op.latestShare > 0.0001)
          .slice(0, 12)
          .map((op) => {
            const deltaPct = op.delta * 100;
            const series = op.series.map((p) => p.share * 100);
            return (
              <div
                key={op.operator}
                className="px-4 py-3 grid grid-cols-12 gap-3 items-center"
              >
                <div className="col-span-12 sm:col-span-3 flex items-center gap-2 min-w-0">
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: getContributorColor(op.operator) }}
                  />
                  <span className="text-sm font-medium truncate">
                    {getContributorDisplayName(op.operator)}
                  </span>
                </div>
                <div className="col-span-12 sm:col-span-5">
                  <Sparkline
                    data={series}
                    width={400}
                    height={32}
                    className="w-full text-cream-60"
                    stroke={getContributorColor(op.operator)}
                    fill={getContributorColor(op.operator)}
                  />
                </div>
                <div className="col-span-4 sm:col-span-1 text-right tabular-nums font-mono text-sm">
                  {(op.latestShare * 100).toFixed(2)}%
                </div>
                <div className="col-span-4 sm:col-span-2 text-right tabular-nums font-mono text-xs">
                  <span
                    className={`inline-flex items-center gap-0.5 ${
                      deltaPct > 0.05
                        ? "text-emerald-400"
                        : deltaPct < -0.05
                        ? "text-red-400"
                        : "text-cream-30"
                    }`}
                  >
                    {deltaPct > 0.05 ? (
                      <ArrowUpRight className="size-3" />
                    ) : deltaPct < -0.05 ? (
                      <ArrowDownRight className="size-3" />
                    ) : (
                      <Minus className="size-3" />
                    )}
                    {deltaPct >= 0 ? "+" : ""}
                    {deltaPct.toFixed(2)}%
                  </span>
                </div>
                <div className="col-span-4 sm:col-span-1 text-right tabular-nums font-mono text-xs text-cream-30">
                  σ {(op.stdev * 100).toFixed(2)}
                </div>
              </div>
            );
          })}
      </div>

      <div className="border-t border-border px-4 py-3 text-xs text-cream-30 font-mono leading-relaxed">
        {data.note}
      </div>
    </div>
  );
}
