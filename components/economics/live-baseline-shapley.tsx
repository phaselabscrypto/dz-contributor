"use client";

import { useBaselineShapley } from "@/lib/hooks/use-live";
import {
  getContributorColor,
  getContributorDisplayName,
} from "@/lib/constants/config";
import { downloadCsv, rowsToCsv } from "@/lib/utils/csv";
import { Download, AlertCircle } from "lucide-react";

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / (60 * 60_000))}h ago`;
}

/**
 * Latest-epoch canonical Shapley anchor. Different from the all-time `reward_percentage`
 * surfaced from economic-hub — this is "what would the contributor pool split
 * look like if rewards were paid against the current network?"
 *
 * When the Rust solver is wired, `method = "lp-multi-commodity-flow-rs"` is
 * shown; otherwise the TS fallback label is shown to be honest about precision.
 */
export function LiveBaselineShapley() {
  const { data, isLoading, error } = useBaselineShapley();

  const ranked = data
    ? Object.entries(data.values)
        .map(([operator, v]) => ({
          operator,
          value: v.value,
          share: v.share,
        }))
        .filter((r) => r.share > 0)
        .sort((a, b) => b.share - a.share)
    : [];

  const handleExport = () => {
    if (!data) return;
    const csv = rowsToCsv(
      ["Operator", "Display Name", "Value", "Share %"],
      ranked.map((r) => [
        r.operator,
        getContributorDisplayName(r.operator),
        r.value.toFixed(6),
        (r.share * 100).toFixed(4),
      ]),
    );
    downloadCsv(
      `dz-baseline-shapley-${new Date().toISOString().slice(0, 10)}.csv`,
      csv,
    );
  };

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Latest-epoch Shapley anchor
        </span>
        <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono">
          {data && (
            <>
              <span title={data.method}>{methodLabel(data.method)}</span>
              <span aria-hidden="true">·</span>
              <span title={data.computedAt}>
                {relativeAge(data.computedAt)}
              </span>
              <button
                onClick={handleExport}
                className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                aria-label="Export CSV"
              >
                <Download className="size-3" />
                CSV
              </button>
            </>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="px-4 py-6 text-xs text-muted-foreground font-mono">
          Computing latest-epoch baseline…
        </div>
      )}

      {error && !isLoading && (
        <div className="px-4 py-3 text-xs text-amber-400 font-mono flex items-start gap-2">
          <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
          <span>
            Couldn&apos;t compute baseline ({(error as Error).message}).
            All-time reward share above is unaffected.
          </span>
        </div>
      )}

      {!isLoading && !error && ranked.length === 0 && (
        <div className="px-4 py-6 text-xs text-muted-foreground font-mono">
          No operators with non-zero share for the latest epoch.
        </div>
      )}

      {ranked.length > 0 && (
        <div>
          {ranked.map((r) => {
            const color = getContributorColor(r.operator);
            const pct = r.share * 100;
            return (
              <div
                key={r.operator}
                className="grid grid-cols-12 gap-3 items-center border-b border-border last:border-b-0 px-4 py-2.5 hover:bg-surface-2/40"
              >
                <div className="col-span-12 sm:col-span-3 flex items-center gap-2.5 min-w-0">
                  <span
                    className="size-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="font-medium text-sm truncate">
                    {getContributorDisplayName(r.operator)}
                  </span>
                </div>
                <div className="col-span-8 sm:col-span-7">
                  <div className="h-1.5 bg-cream-8 overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${Math.min(pct * 2, 100)}%`,
                        backgroundColor: color,
                      }}
                    />
                  </div>
                </div>
                <div className="col-span-4 sm:col-span-2 text-right tabular-nums font-mono text-sm">
                  {pct.toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="px-4 py-2 text-xs text-muted-foreground font-mono border-t border-border">
        Latest completed epoch, canonical (DZ-current methodology) — different
        from the all-time share above, which sums historical pool distributions.
      </div>
    </div>
  );
}

function methodLabel(method: string): string {
  if (method.startsWith("lp-")) return "Canonical LP";
  if (method.includes("fallback")) return "TS heuristic (fallback)";
  return method;
}
