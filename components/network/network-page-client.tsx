"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  useLiveTopology,
  useLiveStatus,
  useEconomicHub,
  useBaselineShapley,
} from "@/lib/hooks/use-live";
import {
  ehNameToCode,
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import { AlertTriangle, ArrowRight, ExternalLink } from "lucide-react";
import dynamic from "next/dynamic";
import { MetroDemand } from "@/components/network/metro-demand";

// Map drags in d3-projection + react-simple-maps (~150KB gzipped). Defer
// until client paint to keep the page's initial JS small.
const LiveMap = dynamic(
  () => import("@/components/network/live-map").then((m) => m.LiveMap),
  {
    ssr: false,
    loading: () => (
      <div className="border border-border bg-surface aspect-[16/7] flex items-center justify-center text-xs font-mono uppercase tracking-[0.14em] text-muted-foreground">
        Loading map…
      </div>
    ),
  },
);
import {
  ErrorState,
  StatRowSkeleton,
  SectionSkeleton,
} from "@/components/ui/states";
import { fmtBps } from "@/lib/utils/format";

export default function NetworkPageClient() {
  const {
    data: topology,
    isLoading: topoLoading,
    error: topoError,
    mutate: refetchTopology,
  } = useLiveTopology();
  const { data: status } = useLiveStatus();
  const { data: hub } = useEconomicHub();
  const { data: baseline } = useBaselineShapley();

  // Merge live link counts with all-time reward share + live Shapley share
  const leaderboard = useMemo(() => {
    if (!topology) return [];
    const ehByCode = new Map<string, number>();
    if (hub) {
      for (const c of hub.contributors) {
        ehByCode.set(ehNameToCode(c.name), c.rewardPercentage);
      }
    }
    return [...topology.contributors]
      .filter((c) => c.linkCount > 0)
      .map((c) => {
        const rewardPct = ehByCode.get(c.code) ?? 0;
        const livePct = baseline?.values?.[c.code]?.share
          ? baseline.values[c.code].share * 100
          : 0;
        return { ...c, rewardPct, livePct };
      })
      .sort((a, b) => b.rewardPct - a.rewardPct || b.linkCount - a.linkCount);
  }, [topology, hub, baseline]);

  if (topoError && !topology) {
    return (
      <ErrorState
        title="Couldn't load network topology"
        message={(topoError as Error).message}
        onRetry={() => refetchTopology()}
      />
    );
  }

  if (topoLoading || !topology) {
    return (
      <div className="space-y-6">
        <StatRowSkeleton count={5} />
        <SectionSkeleton title="Live network map" />
        <SectionSkeleton title="Top contributors" />
      </div>
    );
  }

  const totalBandwidth = topology.contributors.reduce(
    (s, c) => s + c.totalBandwidthBps,
    0,
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-px border border-border bg-border">
        <Stat label="Contributors" value={topology.contributors.length} />
        <Stat label="Metros" value={topology.metros.length} />
        <Stat label="Devices" value={topology.devices.length} />
        <Stat label="Links" value={topology.links.length} />
        <Stat label="Bandwidth" value={fmtBps(totalBandwidth)} numeric={false} />
      </div>

      <LiveMap topology={topology} status={status} />

      {/* Active issues */}
      {status && status.issues.length > 0 && (
        <div className="border border-amber-500/30 bg-amber-500/5">
          <div className="border-b border-amber-500/20 px-4 py-2.5 flex items-center gap-2">
            <AlertTriangle className="size-3.5 text-amber-400" />
            <span className="text-xs uppercase tracking-[0.14em] text-amber-300 font-mono">
              Active issues ({status.issues.length})
            </span>
          </div>
          <div className="divide-y divide-amber-500/10">
            {status.issues.slice(0, 6).map((issue, i) => (
              <div
                key={`${issue.code}-${i}`}
                className="px-4 py-2 flex items-center justify-between gap-3 text-xs"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-cream-30 truncate">
                    {issue.code}
                  </span>
                  <span className="text-amber-300 capitalize">
                    {issue.issue.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-cream-40 font-mono">
                  <span>
                    {issue.sideAMetro?.toUpperCase()} →{" "}
                    {issue.sideZMetro?.toUpperCase()}
                  </span>
                  <span className="text-cream-60">
                    {getContributorDisplayName(issue.contributor)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-metro demand */}
      <MetroDemand topology={topology} />

      {/* Top util links — bars scale relative to the peak in the visible
           list, not absolute % of bandwidth. Real DZ utilisation rarely
           exceeds 10%, so a 0–100% scale renders every bar near-empty. */}
      {status && status.topUtilLinks.length > 0 && (
        <div className="border border-border bg-surface">
          <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
            <span>Most utilised links</span>
            <span className="text-cream-30 normal-case tracking-normal">
              {(() => {
                const visible = status.topUtilLinks.slice(0, 5);
                const peak = Math.max(
                  ...visible.map((v) =>
                    Math.max(v.utilizationOut, v.utilizationIn) * 100,
                  ),
                  0,
                );
                return `bars relative to ${peak.toFixed(1)}% peak`;
              })()}
            </span>
          </div>
          <div className="divide-y divide-border">
            {(() => {
              const visible = status.topUtilLinks.slice(0, 5);
              const peakInList = Math.max(
                ...visible.map((v) =>
                  Math.max(v.utilizationOut, v.utilizationIn) * 100,
                ),
                0.01, // avoid divide-by-zero
              );
              return visible.map((l) => {
                const utilOut = l.utilizationOut * 100;
                const utilIn = l.utilizationIn * 100;
                const peak = Math.max(utilOut, utilIn);
                const ratio = peak / peakInList; // 0–1, top of list = 1
                const color =
                  ratio >= 0.66
                    ? "bg-amber-400"
                    : ratio >= 0.33
                    ? "bg-emerald-400"
                    : "bg-cream-30";
                return (
                <div
                  key={l.pk}
                  className="px-4 py-2.5 flex items-center justify-between gap-4 text-xs"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-cream-60 tabular-nums w-12 text-right">
                      {peak.toFixed(2)}%
                    </span>
                    <div className="w-24 h-1.5 bg-cream-8 overflow-hidden shrink-0">
                      <div
                        className={`h-full ${color}`}
                        style={{ width: `${ratio * 100}%` }}
                      />
                    </div>
                    <span className="font-mono text-cream-40 tabular-nums shrink-0">
                      {l.sideAMetro.toUpperCase()} →{" "}
                      {l.sideZMetro.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-cream-40 shrink-0">
                    <span className="font-mono">{fmtBps(l.bandwidthBps)}</span>
                    <span>{getContributorDisplayName(l.contributor)}</span>
                  </div>
                </div>
              );
              });
            })()}
          </div>
        </div>
      )}

      {/* Reward leaderboard with live data */}
      <div className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
            Top contributors
          </span>
          <div className="flex items-center gap-3 text-xs font-mono">
            {baseline && (
              <span className="text-emerald-300/80 hidden md:inline">
                live
              </span>
            )}
            {hub && (
              <span className="text-muted-foreground">
                all-time · {hub.epochs.length} epochs
              </span>
            )}
          </div>
        </div>
        <div className="divide-y divide-border">
          {leaderboard.slice(0, 12).map((c, i) => (
            <Link
              key={c.code}
              href={`/contributors/${c.code}`}
              className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-surface-2/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-5 text-right tabular-nums text-muted-foreground font-mono text-xs">
                  {i + 1}
                </span>
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ backgroundColor: getContributorColor(c.code) }}
                />
                <span className="font-medium truncate">
                  {getContributorDisplayName(c.code)}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
                  {c.linkCount} links · {c.metros.length} metros · {c.deviceCount} devices
                </span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {baseline && c.livePct > 0 && (
                  <span
                    className="tabular-nums font-mono text-xs text-emerald-300/80 hidden md:inline"
                    title="Live Shapley share against current network"
                  >
                    {c.livePct.toFixed(2)}%
                  </span>
                )}
                <span
                  className="tabular-nums font-mono text-sm"
                  title="All-time payout share"
                >
                  {c.rewardPct > 0
                    ? `${c.rewardPct.toFixed(2)}%`
                    : "—"}
                </span>
                <ArrowRight className="size-3.5 text-cream-30" />
              </div>
            </Link>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground font-mono flex items-center gap-1">
        Sources:
        <a
          href="https://data.malbeclabs.com/api/topology"
          className="underline decoration-dotted hover:text-foreground inline-flex items-center gap-1"
          target="_blank"
          rel="noreferrer"
        >
          malbec/topology <ExternalLink className="size-3" />
        </a>
        ·
        <a
          href="https://doublezero.xyz/api/economic-hub"
          className="underline decoration-dotted hover:text-foreground inline-flex items-center gap-1"
          target="_blank"
          rel="noreferrer"
        >
          dz/economic-hub <ExternalLink className="size-3" />
        </a>
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  numeric = true,
}: {
  label: string;
  value: number | string;
  numeric?: boolean;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className="mt-1 text-2xl font-mono tabular-nums">
        {numeric && typeof value === "number"
          ? value.toLocaleString()
          : value}
      </div>
    </div>
  );
}
