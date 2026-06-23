"use client";

import Link from "next/link";
import {
  useLiveStats,
  useLiveStatus,
  useHealth,
  type SourceHealth,
} from "@/lib/hooks/use-live";
import { cn } from "@/lib/utils";

function formatBps(bps: number): string {
  if (bps >= 1e12) return `${(bps / 1e12).toFixed(1)}T`;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(0)}G`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(0)}M`;
  return `${bps}`;
}

/**
 * Worst-of severity across link health + every source probe.
 * Returns a Tailwind background-color class for the heartbeat dot.
 */
function severityDot(
  linkHealthyPct: number | null,
  sources: SourceHealth[] | undefined,
): string {
  // Source-level outage trumps link health.
  if (sources && sources.some((s) => s.status === "down")) return "bg-red-400";

  if (linkHealthyPct === null) {
    if (sources && sources.some((s) => s.status === "degraded"))
      return "bg-amber-400";
    return "bg-cream-30";
  }
  if (linkHealthyPct >= 95) {
    return sources && sources.some((s) => s.status === "degraded")
      ? "bg-amber-400"
      : "bg-emerald-400";
  }
  if (linkHealthyPct >= 85) return "bg-amber-400";
  return "bg-red-400";
}

/**
 * Sidebar heartbeat. Network stats + link health + source-feed health.
 * Refreshes link/topology every 60s, /api/health every 30s.
 */
export function NetworkPulse() {
  const { data: stats } = useLiveStats();
  const { data: status } = useLiveStatus();
  const { data: health } = useHealth();

  const linkHealth = status?.linkHealth;
  const totalLinks = linkHealth?.total ?? 0;
  const linkHealthyPct =
    totalLinks > 0 ? ((linkHealth?.healthy ?? 0) / totalLinks) * 100 : null;
  const issues = status?.issues?.length ?? 0;

  // Filter out disabled sources from the visible "Sources" line, but
  // count them in the total so it's clear how many are wired.
  const visibleSources = (health?.sources ?? []).filter(
    (s) => s.status !== "disabled",
  );
  const sourcesOk = visibleSources.filter((s) => s.status === "ok").length;
  const sourcesTotal = visibleSources.length;

  const dot = severityDot(linkHealthyPct, health?.sources);

  return (
    <div className="border-t border-border px-5 py-3 space-y-2">
      <Link
        href="/status"
        className="flex items-center justify-between gap-2 text-xs uppercase tracking-[0.16em] text-muted-foreground font-mono hover:text-foreground transition-colors"
        aria-label="View source status"
      >
        <span className="flex items-center gap-2">
          <span className={cn("size-1.5 rounded-full", dot, "animate-pulse")} />
          Network Pulse
        </span>
        <span className="text-cream-30">›</span>
      </Link>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs font-mono tabular-nums">
        <Row label="Validators" value={stats?.validatorsOnDz ?? "…"} />
        <Row
          label="Stake %"
          value={stats ? `${stats.stakeSharePct.toFixed(1)}` : "…"}
        />
        <Row
          label="Bandwidth"
          value={stats ? formatBps(stats.bandwidthBps) : "…"}
        />
        <Row label="Links" value={stats?.links ?? "…"} />
        <Row
          label="Healthy"
          value={linkHealth ? `${linkHealth.healthy}/${totalLinks}` : "…"}
        />
        <Row
          label="Issues"
          value={issues}
          tone={issues > 0 ? "warn" : "ok"}
        />
        <Row
          label="Sources"
          value={
            sourcesTotal > 0 ? `${sourcesOk}/${sourcesTotal}` : "…"
          }
          tone={
            sourcesTotal === 0
              ? undefined
              : sourcesOk === sourcesTotal
              ? "ok"
              : "warn"
          }
        />
      </div>
    </div>
  );
}

/**
 * Compact heartbeat dot + condensed status for the mobile top bar.
 */
export function NetworkPulseCompact() {
  const { data: status } = useLiveStatus();
  const { data: health } = useHealth();

  const linkHealth = status?.linkHealth;
  const totalLinks = linkHealth?.total ?? 0;
  const linkHealthyPct =
    totalLinks > 0 ? ((linkHealth?.healthy ?? 0) / totalLinks) * 100 : null;
  const issues = status?.issues?.length ?? 0;
  const sourcesDown = (health?.sources ?? []).filter(
    (s) => s.status === "down",
  ).length;

  const dot = severityDot(linkHealthyPct, health?.sources);

  return (
    <Link
      href="/status"
      aria-label="View source status"
      className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground transition-colors"
    >
      <span className={cn("size-1.5 rounded-full", dot, "animate-pulse")} />
      {sourcesDown > 0 ? (
        <span className="text-red-400 tabular-nums">
          {sourcesDown} source{sourcesDown === 1 ? "" : "s"} down
        </span>
      ) : issues > 0 ? (
        <span className="text-amber-400 tabular-nums">
          {issues} issue{issues === 1 ? "" : "s"}
        </span>
      ) : linkHealthyPct !== null ? (
        <span className="tabular-nums">{linkHealthyPct.toFixed(0)}%</span>
      ) : (
        <span>live</span>
      )}
    </Link>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-cream-30">{label}</span>
      <span
        className={cn(
          "text-foreground",
          tone === "warn" && "text-amber-400",
          tone === "ok" && "text-emerald-400/80",
        )}
      >
        {value}
      </span>
    </div>
  );
}
