"use client";

import { useEconomicHub } from "@/lib/hooks/use-live";
import { ehNameToCode, getContributorColor } from "@/lib/constants/config";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";
import { Download } from "lucide-react";
import { EpochRewardHistory } from "@/components/economics/epoch-reward-history";
import { ShareVsFootprint } from "@/components/economics/share-vs-footprint";
import { LiveBaselineShapley } from "@/components/economics/live-baseline-shapley";
import { PoolProjection } from "@/components/economics/pool-projection";
import { ShapleyTracking } from "@/components/economics/shapley-tracking";
import { WeeklyDigest } from "@/components/economics/weekly-digest";
import { ExternalLink } from "lucide-react";
import {
  ErrorState,
  StatRowSkeleton,
  SectionSkeleton,
  TableSkeleton,
} from "@/components/ui/states";
import { fmtBps } from "@/lib/utils/format";

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
function fmtUsd(n: number, digits = 0): string {
  return "$" + fmtNum(n, digits);
}
function fmtKm(km: number): string {
  if (km >= 1000) return `${(km / 1000).toFixed(1)}k km`;
  return `${km.toFixed(0)} km`;
}

export default function EconomicsPageClient() {
  const { data, isLoading, error, mutate } = useEconomicHub();

  if (error && !data) {
    return (
      <ErrorState
        title="Couldn't load economic hub"
        message={(error as Error).message}
        onRetry={() => mutate()}
      />
    );
  }
  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <StatRowSkeleton count={4} />
        <SectionSkeleton title="Live network reward share" />
        <TableSkeleton rows={8} columns={5} />
        <SectionSkeleton title="Pool projection" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px border border-border bg-border">
        <Stat
          label="Distributed (2Z)"
          value={fmtNum(data.totalDistributed2Z, 0)}
          sub={fmtUsd(data.totalDistributed2ZUsd)}
        />
        <Stat
          label="Pending 2Z payouts"
          value={fmtNum(data.total2ZDebt, 0)}
          sub={fmtUsd(data.total2ZDebtUsd)}
        />
        <Stat
          label="Burned (2Z)"
          value={fmtNum(data.burned2Z, 0)}
          sub={fmtUsd(data.burned2ZUsd)}
        />
        <Stat
          label="Pending SOL payouts"
          value={fmtNum(data.totalSolDebt, 1)}
          sub={fmtUsd(data.totalSolDebtUsd)}
        />
      </div>
      <p className="text-xs text-muted-foreground font-mono leading-relaxed">
        Distributed = 2Z already paid out to contributors. Pending payouts =
        rewards accrued in finalized epochs but not yet sent on-chain. Burned =
        the 10% share of revenue that&apos;s permanently removed per the
        45/45/10 split. All values from{" "}
        <a
          href="https://doublezero.xyz/api/economic-hub"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted hover:text-foreground"
        >
          doublezero.xyz/api/economic-hub
        </a>
        .
      </p>

      <div className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Network footprint
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
          <Stat
            label="WAN links"
            value={fmtNum(data.totalWanLinks)}
            sub={`+ ${fmtNum(data.totalDzxLinks)} DZX`}
          />
          <Stat label="Bandwidth" value={fmtBps(data.totalBandwidthBps)} />
          <Stat label="Fiber" value={fmtKm(data.totalFiberLength)} />
          <Stat
            label="Distributed epochs"
            value={fmtNum(data.epochs.length)}
            sub={`Latest: ${data.currentEpoch}`}
          />
        </div>
      </div>

      <WeeklyDigest />
      <LiveBaselineShapley />

      <div className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3">
          <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
            Reward distribution
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
              All-time share
            </span>
            <button
              type="button"
              onClick={() => {
                const headers = [
                  "Contributor",
                  "Reward %",
                  "Earned 2Z",
                  "Earned USD",
                  "Devices",
                  "WAN links",
                  "DZX links",
                  "Bandwidth (bps)",
                  "Fiber (km)",
                ];
                const rows = data.contributors.map((c) => [
                  c.name,
                  c.rewardPercentage.toFixed(6),
                  ((c.rewardPercentage / 100) * data.totalDistributed2Z).toFixed(2),
                  ((c.rewardPercentage / 100) * data.totalDistributed2ZUsd).toFixed(2),
                  c.devices,
                  c.wanLinks,
                  c.dzxLinks,
                  c.bandwidthBps,
                  c.totalFiberLength.toFixed(2),
                ]);
                downloadCsv(
                  `dz-rewards-${new Date().toISOString().slice(0, 10)}.csv`,
                  rowsToCsv(headers, rows),
                );
              }}
              className="inline-flex items-center gap-1.5 text-xs font-mono uppercase tracking-[0.12em] text-cream-30 hover:text-foreground transition-colors"
            >
              <Download className="size-3" />
              CSV
            </button>
          </div>
        </div>
        <div>
          {data.contributors
            .filter((c) => c.rewardPercentage > 0 || c.devices > 0)
            .map((c) => {
              const code = ehNameToCode(c.name);
              const color = getContributorColor(code);
              const earned2Z =
                (c.rewardPercentage / 100) * data.totalDistributed2Z;
              const earnedUsd =
                (c.rewardPercentage / 100) * data.totalDistributed2ZUsd;
              return (
                <div
                  key={c.name}
                  className="grid grid-cols-12 gap-3 items-center border-b border-border last:border-b-0 px-4 py-3 hover:bg-surface-2/40"
                >
                  <div className="col-span-12 sm:col-span-3 flex items-center gap-2.5 min-w-0">
                    <span
                      className="size-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: color }}
                    />
                    <span className="font-medium text-sm truncate">
                      {c.name}
                    </span>
                  </div>
                  <div className="col-span-12 sm:col-span-4">
                    <div className="h-1.5 bg-cream-8 overflow-hidden">
                      <div
                        className="h-full"
                        style={{
                          width: `${Math.min(c.rewardPercentage * 2, 100)}%`,
                          backgroundColor: color,
                        }}
                      />
                    </div>
                  </div>
                  <div className="col-span-4 sm:col-span-1 text-right tabular-nums font-mono text-sm">
                    {c.rewardPercentage.toFixed(2)}%
                  </div>
                  <div className="col-span-4 sm:col-span-2 text-right tabular-nums font-mono text-sm text-cream-80">
                    {fmtNum(earned2Z, 0)} 2Z
                  </div>
                  <div className="col-span-4 sm:col-span-2 text-right tabular-nums font-mono text-xs text-cream-40">
                    {fmtUsd(earnedUsd)}
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      <ShareVsFootprint />

      <div className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Contributor footprint
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                <Th align="left">Contributor</Th>
                <Th align="right" className="hidden sm:table-cell">Devices</Th>
                <Th align="right" className="hidden md:table-cell">WAN</Th>
                <Th align="right" className="hidden md:table-cell">DZX</Th>
                <Th align="right">Bandwidth</Th>
                <Th align="right" className="hidden lg:table-cell">Fiber</Th>
                <Th align="right">Reward %</Th>
              </tr>
            </thead>
            <tbody>
              {data.contributors.map((c) => (
                <tr
                  key={c.name}
                  className="border-b border-border last:border-b-0 hover:bg-surface-2/40"
                >
                  <td className="px-3 py-2 font-medium truncate max-w-[180px] sm:max-w-none">{c.name}</td>
                  <td className="hidden sm:table-cell px-3 py-2 text-right tabular-nums font-mono">
                    {c.devices}
                  </td>
                  <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums font-mono">
                    {c.wanLinks}
                  </td>
                  <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums font-mono">
                    {c.dzxLinks}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono">
                    {fmtBps(c.bandwidthBps)}
                  </td>
                  <td className="hidden lg:table-cell px-3 py-2 text-right tabular-nums font-mono">
                    {fmtKm(c.totalFiberLength)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono">
                    {c.rewardPercentage.toFixed(3)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <EpochRewardHistory />

      <PoolProjection />

      <ShapleyTracking />

      <div className="border border-border bg-surface px-4 py-3 text-xs text-cream-30 font-mono flex items-center justify-between">
        <span>Epoch {data.epochs[0]}</span>
        <span>{data.epochs.length} distributed</span>
        <span>Epoch {data.epochs[data.epochs.length - 1]}</span>
      </div>

      <p className="text-xs text-muted-foreground font-mono flex items-center gap-1">
        Source:
        <a
          href="https://doublezero.xyz/api/economic-hub"
          className="underline decoration-dotted hover:text-foreground inline-flex items-center gap-1"
          target="_blank"
          rel="noreferrer"
        >
          doublezero.xyz/api/economic-hub <ExternalLink className="size-3" />
        </a>
        · updated {new Date(data.updatedAt).toLocaleString()}
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className="mt-1 text-2xl font-mono tabular-nums">{value}</div>
      {sub && (
        <div className="text-xs text-cream-40 font-mono mt-0.5">{sub}</div>
      )}
    </div>
  );
}

function Th({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <th
      className={`px-3 py-2 font-normal ${
        align === "right"
          ? "text-right"
          : align === "center"
          ? "text-center"
          : "text-left"
      } ${className}`}
    >
      {children}
    </th>
  );
}
