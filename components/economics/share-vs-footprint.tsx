"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useEconomicHub, useLiveTopology } from "@/lib/hooks/use-live";
import {
  ehNameToCode,
  getContributorColor,
  getContributorDisplayName,
} from "@/lib/constants/config";
import { ArrowRight } from "lucide-react";

/**
 * Compare each contributor's all-time reward share to their current
 * network footprint share (bandwidth-weighted). A positive delta means
 * they earn more than their current footprint suggests; negative means
 * they grew faster than their reward history.
 *
 * Uses live topology + economic-hub. Sorted by absolute delta so the
 * most interesting movers float to the top.
 */
export function ShareVsFootprint() {
  const { data: hub } = useEconomicHub();
  const { data: topology } = useLiveTopology();

  const rows = useMemo(() => {
    if (!hub || !topology) return [];

    const totalBandwidth = topology.contributors.reduce(
      (s, c) => s + c.totalBandwidthBps,
      0,
    );
    if (totalBandwidth === 0) return [];

    const footprintByCode = new Map<string, number>();
    for (const c of topology.contributors) {
      footprintByCode.set(c.code, (c.totalBandwidthBps / totalBandwidth) * 100);
    }

    return hub.contributors
      .filter((c) => c.rewardPercentage > 0 || c.bandwidthBps > 0)
      .map((c) => {
        const code = ehNameToCode(c.name);
        const rewardPct = c.rewardPercentage;
        const footprintPct = footprintByCode.get(code) ?? 0;
        return {
          code,
          name: c.name,
          rewardPct,
          footprintPct,
          deltaPct: rewardPct - footprintPct,
        };
      })
      .filter((r) => r.rewardPct > 0 || r.footprintPct > 0)
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  }, [hub, topology]);

  if (rows.length === 0) return null;

  const maxAbs = Math.max(
    ...rows.map((r) => Math.max(r.rewardPct, r.footprintPct)),
    1,
  );

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Share vs current footprint
        </span>
        <span className="text-xs text-muted-foreground font-mono">
          Reward % − bandwidth %
        </span>
      </div>
      <div className="divide-y divide-border">
        {rows.map((r) => {
          const color = getContributorColor(r.code);
          const tone =
            r.deltaPct > 1
              ? "text-emerald-300"
              : r.deltaPct < -1
              ? "text-amber-300"
              : "text-cream-60";
          return (
            <Link
              key={r.code}
              href={`/contributors/${r.code}`}
              className="grid grid-cols-12 gap-3 items-center px-4 py-3 hover:bg-surface-2/40 transition-colors"
            >
              <div className="col-span-12 sm:col-span-3 flex items-center gap-2.5 min-w-0">
                <span
                  className="size-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="font-medium text-sm truncate">
                  {getContributorDisplayName(r.code)}
                </span>
              </div>
              <div className="col-span-12 sm:col-span-6">
                <div className="grid grid-cols-2 gap-2 items-center">
                  <Bar
                    label="Reward"
                    pct={r.rewardPct}
                    max={maxAbs}
                    color={color}
                  />
                  <Bar
                    label="Footprint"
                    pct={r.footprintPct}
                    max={maxAbs}
                    color="var(--cream-30)"
                    striped
                  />
                </div>
              </div>
              <div
                className={`col-span-12 sm:col-span-3 flex items-center justify-end gap-1.5 text-sm tabular-nums font-mono ${tone}`}
              >
                {r.deltaPct >= 0 ? "+" : ""}
                {r.deltaPct.toFixed(2)}%
                <ArrowRight className="size-3 text-cream-30" />
              </div>
            </Link>
          );
        })}
      </div>
      <div className="border-t border-border px-4 py-2 text-xs font-mono text-cream-30 leading-relaxed">
        Positive delta = reward share exceeds current bandwidth share (earned
        more than today&apos;s footprint suggests). Negative = grew faster than
        reward history reflects.
      </div>
    </div>
  );
}

function Bar({
  label,
  pct,
  max,
  color,
  striped,
}: {
  label: string;
  pct: number;
  max: number;
  color: string;
  striped?: boolean;
}) {
  const w = max > 0 ? (pct / max) * 100 : 0;
  return (
    <div className="space-y-1 min-w-0">
      <div className="text-xs font-mono text-cream-30 uppercase tracking-[0.12em] flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-cream-60">{pct.toFixed(2)}%</span>
      </div>
      <div className="h-1.5 bg-cream-8 overflow-hidden">
        <div
          className="h-full"
          style={{
            width: `${Math.min(w, 100)}%`,
            backgroundColor: color,
            backgroundImage: striped
              ? "repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(0,0,0,0.15) 2px, rgba(0,0,0,0.15) 4px)"
              : undefined,
          }}
        />
      </div>
    </div>
  );
}
