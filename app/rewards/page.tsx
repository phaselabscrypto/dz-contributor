"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useFees } from "@/lib/hooks/use-fees";
import { PageHeader } from "@/components/ui/page-header";
import { Sparkline } from "@/components/ui/sparkline";
import { Download } from "lucide-react";
import { LoadingState, ErrorState, EmptyState } from "@/components/ui/states";

const LAMPORTS_PER_SOL = 1_000_000_000;

function fmtSol(lamports: number, decimals = 2): string {
  return (lamports / LAMPORTS_PER_SOL).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtUsd(lamports: number, solUsd: number | null): string {
  if (solUsd === null) return "—";
  const sol = lamports / LAMPORTS_PER_SOL;
  const usd = sol * solUsd;
  if (usd >= 1_000_000) {
    return `$${(usd / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
  }
  if (usd >= 1_000) {
    return `$${(usd / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
  }
  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

export default function RewardsPage() {
  const { data: feeHistory, isLoading, error, mutate } = useFees();

  const trendSeries = useMemo(
    () =>
      feeHistory?.epochs
        ? [...feeHistory.epochs]
            .sort((a, b) => a.solanaEpoch - b.solanaEpoch)
            .map((e) => e.totalFeeLamports)
        : [],
    [feeHistory],
  );

  const measuredEpochs = useMemo(
    () => feeHistory?.epochs?.filter((e) => !e.isEstimated) ?? [],
    [feeHistory],
  );

  const handleExportCSV = () => {
    if (!feeHistory?.epochs) return;
    const header = ["solana_epoch", "fee_lamports", "fee_sol", "fee_usd", "is_estimated"].join(",");
    const rows = feeHistory.epochs.map((e) => {
      const sol = e.totalFeeLamports / LAMPORTS_PER_SOL;
      const usd = feeHistory.solUsdPrice ? sol * feeHistory.solUsdPrice : "";
      return [
        e.solanaEpoch,
        e.totalFeeLamports,
        sol.toFixed(4),
        usd === "" ? "" : usd.toFixed(2),
        e.isEstimated ? "1" : "0",
      ].join(",");
    });
    const csv = [header, ...rows].join("\n") + "\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dz-fee-revenue-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Fee revenue history"
        description="DoubleZero protocol fee revenue per Solana epoch. This is the pool that funds the 45 / 45 / 10 split."
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
        {error && !feeHistory ? (
          <ErrorState
            title="Couldn't load fee history"
            message={(error as Error).message}
            onRetry={() => mutate()}
          />
        ) : isLoading ? (
          <LoadingState label="Loading fee history" />
        ) : !feeHistory?.epochs || feeHistory.epochs.length === 0 ? (
          <EmptyState
            title="No fee data available"
            message="The historical fee feed is empty right now."
          />
        ) : (
          <div className="space-y-6">
            {/* Explainer */}
            <div className="border border-border bg-surface px-4 py-3 text-xs text-cream-60 leading-relaxed">
              These are protocol fees that fund the DoubleZero reward
              distribution: <span className="text-foreground">45%</span> to
              contributors (Shapley-weighted, see{" "}
              <Link
                href="/contributors"
                className="underline decoration-dotted hover:text-foreground"
              >
                /contributors
              </Link>
              ), <span className="text-foreground">45%</span> to validators
              (stake-weighted × 65%, see{" "}
              <Link
                href="/validators"
                className="underline decoration-dotted hover:text-foreground"
              >
                /validators
              </Link>
              ), <span className="text-foreground">10%</span> burned. Values
              recorded on chain in lamports; this page shows SOL plus a live
              USD equivalent from Jupiter. Full math:{" "}
              <Link
                href="/methodology"
                className="underline decoration-dotted hover:text-foreground"
              >
                /methodology
              </Link>
              .
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-px border border-border bg-border">
              <Stat
                label="Total fees collected"
                value={`${fmtSol(feeHistory.totalFeeLamports, 0)} SOL`}
                sub={fmtUsd(feeHistory.totalFeeLamports, feeHistory.solUsdPrice)}
              />
              <Stat
                label="Average per epoch"
                value={`${fmtSol(feeHistory.averageFeeLamports, 2)} SOL`}
                sub={fmtUsd(feeHistory.averageFeeLamports, feeHistory.solUsdPrice)}
              />
              <Stat
                label="Epochs covered"
                value={fmtInt(feeHistory.epochs.length)}
                sub={`${feeHistory.earliestEpoch}–${feeHistory.latestEpoch}`}
              />
              <Stat
                label="SOL / USD"
                value={
                  feeHistory.solUsdPrice
                    ? `$${feeHistory.solUsdPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                    : "—"
                }
                sub={feeHistory.solUsdPrice ? "live · Jupiter" : "price unavailable"}
              />
            </div>

            {/* Trend chart */}
            {trendSeries.length > 1 && (
              <div className="border border-border bg-surface">
                <div className="border-b border-border px-4 py-2.5 flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                    Per-epoch fee revenue (lamports)
                  </span>
                  <span className="text-xs font-mono text-cream-30 tabular-nums">
                    epoch {feeHistory.earliestEpoch} → {feeHistory.latestEpoch}
                  </span>
                </div>
                <div className="p-4">
                  <Sparkline
                    data={trendSeries}
                    width={1000}
                    height={120}
                    className="w-full text-primary"
                  />
                </div>
              </div>
            )}

            {/* Per-epoch table */}
            <div className="border border-border bg-surface">
              <div className="border-b border-border px-4 py-2.5 flex items-center justify-between">
                <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                  Per-epoch fee revenue
                </span>
                <button
                  type="button"
                  onClick={handleExportCSV}
                  className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Download className="size-3" />
                  CSV
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                      <th className="px-3 py-2 text-left font-normal">Epoch</th>
                      <th className="px-3 py-2 text-right font-normal">SOL collected</th>
                      <th className="px-3 py-2 text-right font-normal">USD at spot</th>
                      <th className="px-3 py-2 text-right font-normal hidden sm:table-cell">
                        Validators paying
                      </th>
                      <th className="px-3 py-2 text-right font-normal hidden md:table-cell">
                        Source
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...feeHistory.epochs]
                      .sort((a, b) => b.solanaEpoch - a.solanaEpoch)
                      .map((epoch) => (
                        <tr
                          key={epoch.solanaEpoch}
                          className="border-b border-border last:border-b-0 hover:bg-surface-2/30 transition-colors"
                        >
                          <td className="px-3 py-2.5 font-mono tabular-nums text-foreground">
                            {epoch.solanaEpoch}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground">
                            {fmtSol(epoch.totalFeeLamports, 2)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-cream-60">
                            {fmtUsd(epoch.totalFeeLamports, feeHistory.solUsdPrice)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-cream-40 hidden sm:table-cell">
                            {epoch.validatorCount > 0 ? fmtInt(epoch.validatorCount) : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs hidden md:table-cell">
                            {epoch.isEstimated ? (
                              <span
                                className="text-amber-400"
                                title="Back-filled from previous_fees aggregate — every pre-934 epoch shares the same averaged value"
                              >
                                estimated
                              </span>
                            ) : (
                              <span className="text-emerald-400/80">measured</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-border px-4 py-2 text-xs text-cream-30 font-mono">
                {measuredEpochs.length} measured · {feeHistory.epochs.length - measuredEpochs.length} estimated (pre-934 back-fill)
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className="mt-1 font-mono tabular-nums text-foreground text-base">
        {value}
      </div>
      <div className="mt-0.5 text-xs text-cream-40 font-mono">{sub}</div>
    </div>
  );
}
