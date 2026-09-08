"use client";

import { useState } from "react";
import {
  cachedTracking,
  hasLoadError,
  useShapleyTracking,
} from "@/lib/hooks/use-live";
import { isNotCached } from "@/lib/types/baseline";
import { Sparkline } from "@/components/ui/sparkline";
import { ErrorState, SectionSkeleton, Skeleton } from "@/components/ui/states";
import {
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";
import {
  AlertCircle,
  Download,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from "lucide-react";

const COUNT_OPTIONS = [4, 8, 12, 16] as const;

/**
 * Per-operator Shapley share trajectories across the published baselines of the
 * latest N epochs. Renders a small sparkline per operator + delta vs
 * first-in-window so users can spot drift. The route is cache-only, so with
 * fewer than two published epochs the card is not shown.
 *
 * Once the card has rendered real data at least once, the header and count
 * picker stay mounted through loading, error and not-cached states so a
 * user-selected empty window doesn't strand them without a way back.
 */
export function ShapleyTracking() {
  const [count, setCount] = useState<number>(8);
  const { data, isLoading, error, mutate } = useShapleyTracking(count);
  const ready = cachedTracking(data);

  const [everReady, setEverReady] = useState(ready !== null);
  if (ready && !everReady) setEverReady(true);

  if (!ready && !everReady) {
    if (hasLoadError(error, data)) {
      return (
        <ErrorState
          title="Couldn't load tracking series"
          message="The tracking series is unavailable."
          onRetry={() => mutate()}
        />
      );
    }
    if (isLoading || !data) {
      return <SectionSkeleton title="Solver tracking" />;
    }
    return null;
  }

  const exportCsv = () => {
    if (!ready) return;
    const headers = ["Operator", "Display Name", ...ready.epochs.map(String), "Δ first→last", "Stdev"];
    const rows = ready.operators.map((op) => [
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
          {ready && (
            <span className="text-xs text-cream-30 font-mono">
              {ready.method}
            </span>
          )}
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
          {ready && (
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Download className="size-3" />
              CSV
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="p-4 space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : hasLoadError(error, data) ? (
        <div className="px-4 py-3 text-xs text-amber-400 font-mono flex items-start gap-2">
          <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
          <span>
            {error instanceof Error && error.message === "API 422"
              ? "Not enough published epochs for this window."
              : "Couldn't refresh the tracking series."}
          </span>
          <button
            type="button"
            onClick={() => mutate()}
            className="inline-flex items-center uppercase tracking-[0.12em] text-cream-40 hover:text-foreground transition-colors"
          >
            Retry
          </button>
        </div>
      ) : isNotCached(data) ? (
        <div className="px-4 py-3 text-xs text-amber-400 font-mono">
          Only {data.epochs.length} of{" "}
          {data.epochs.length + data.missingEpochs.length} epochs are
          published. Not yet published: {data.missingEpochs.join(" · ")}. Pick
          a wider window.
        </div>
      ) : ready ? (
        <>
          <div className="px-4 py-2 text-xs font-mono text-cream-30 border-b border-border">
            Epochs: {ready.epochs.join(" · ")}
            {ready.missingEpochs.length > 0 &&
              ` · not cached: ${ready.missingEpochs.join(" · ")}`}
          </div>

          <div className="divide-y divide-border">
            {ready.operators
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
            Canonical Rust-solver share trajectories across the cached
            baselines of the latest {count} epochs. Epochs the cron has not
            published are listed, not substituted.
          </div>
        </>
      ) : null}
    </div>
  );
}
