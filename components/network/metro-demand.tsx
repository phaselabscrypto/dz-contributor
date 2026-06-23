"use client";

import { useMemo, useState } from "react";
import type { LiveTopology } from "@/lib/types/live";
import { getContributorColor } from "@/lib/constants/config";

interface MetroDemandProps {
  topology: LiveTopology;
}

interface MetroAgg {
  code: string;
  name: string;
  validatorCount: number;
  stakeSol: number;
  deviceCount: number;
  linkCount: number;
  inBps: number;
  outBps: number;
  capacityBps: number;
  contributors: string[]; // unique codes
}

function fmtBps(bps: number): string {
  if (bps >= 1e12) return `${(bps / 1e12).toFixed(2)} Tbps`;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(0)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} Kbps`;
  return `${bps.toFixed(0)} bps`;
}

function fmtSol(sol: number): string {
  if (sol >= 1e6) return `${(sol / 1e6).toFixed(2)}M`;
  if (sol >= 1e3) return `${(sol / 1e3).toFixed(1)}K`;
  return sol.toFixed(0);
}

type SortKey = "demand" | "validators" | "stake" | "capacity" | "code";

export function MetroDemand({ topology }: MetroDemandProps) {
  const [sort, setSort] = useState<SortKey>("demand");
  const [expanded, setExpanded] = useState(false);

  const metros = useMemo<MetroAgg[]>(() => {
    const byCode = new Map<string, MetroAgg>();
    for (const m of topology.metros) {
      byCode.set(m.code, {
        code: m.code,
        name: m.name,
        validatorCount: 0,
        stakeSol: 0,
        deviceCount: 0,
        linkCount: 0,
        inBps: 0,
        outBps: 0,
        capacityBps: 0,
        contributors: [],
      });
    }

    // Devices and validators are aggregated by metro via device → metro mapping
    const deviceMetro = new Map<string, string>();
    for (const d of topology.devices) {
      deviceMetro.set(d.pk, d.metroCode);
      const agg = byCode.get(d.metroCode);
      if (!agg) continue;
      agg.deviceCount++;
      agg.validatorCount += d.validatorCount;
      agg.stakeSol += d.stakeSol;
      if (d.contributorCode && !agg.contributors.includes(d.contributorCode)) {
        agg.contributors.push(d.contributorCode);
      }
    }

    // Validator stake from the validator feed (more reliable than device.stakeSol)
    for (const v of topology.validators) {
      const metro = deviceMetro.get(v.devicePk);
      if (!metro) continue;
      const agg = byCode.get(metro);
      if (!agg) continue;
      // Don't double-count: replace device-aggregated stake with validator stake
    }

    // Links: count once per metro endpoint, capacity aggregated, in/out traffic
    // Capacity is summed once per side (each side gets +bandwidth).
    for (const l of topology.links) {
      const a = byCode.get(l.sideAMetro);
      const z = byCode.get(l.sideZMetro);
      if (a) {
        a.linkCount++;
        a.capacityBps += l.bandwidthBps;
        a.inBps += l.inBps;
        a.outBps += l.outBps;
      }
      if (z && z !== a) {
        z.linkCount++;
        z.capacityBps += l.bandwidthBps;
        z.inBps += l.inBps;
        z.outBps += l.outBps;
      }
    }

    return [...byCode.values()].filter(
      (m) => m.deviceCount > 0 || m.linkCount > 0,
    );
  }, [topology]);

  const sorted = useMemo(() => {
    const m = sort;
    return [...metros].sort((a, b) => {
      switch (m) {
        case "demand":
          return b.inBps + b.outBps - (a.inBps + a.outBps);
        case "validators":
          return b.validatorCount - a.validatorCount;
        case "stake":
          return b.stakeSol - a.stakeSol;
        case "capacity":
          return b.capacityBps - a.capacityBps;
        case "code":
          return a.code.localeCompare(b.code);
      }
    });
  }, [metros, sort]);

  const visible = expanded ? sorted : sorted.slice(0, 8);
  const maxTotalBps = Math.max(
    1,
    ...sorted.map((m) => m.inBps + m.outBps),
  );
  const maxStake = Math.max(1, ...sorted.map((m) => m.stakeSol));

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Metro demand
        </span>
        <div className="flex items-center gap-1 text-xs font-mono">
          {(
            [
              ["demand", "Demand"],
              ["validators", "Validators"],
              ["stake", "Stake"],
              ["capacity", "Capacity"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              className={
                sort === key
                  ? "px-2 py-1 border border-foreground text-foreground"
                  : "px-2 py-1 border border-transparent text-muted-foreground hover:text-foreground hover:border-cream-15"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="divide-y divide-border">
        {visible.map((m) => {
          const totalBps = m.inBps + m.outBps;
          const demandPct = (totalBps / maxTotalBps) * 100;
          const stakePct = (m.stakeSol / maxStake) * 100;
          return (
            <div
              key={m.code}
              className="px-4 py-2.5 grid grid-cols-12 gap-3 items-center text-xs"
            >
              <div className="col-span-12 sm:col-span-3 min-w-0 flex items-center gap-2">
                <span className="font-mono uppercase text-cream-60 w-10 shrink-0">
                  {m.code}
                </span>
                <span className="truncate">{m.name}</span>
              </div>

              <div className="col-span-7 sm:col-span-4 space-y-1">
                <div className="h-1.5 bg-cream-8 overflow-hidden">
                  <div
                    className="h-full bg-info"
                    style={{ width: `${demandPct}%` }}
                  />
                </div>
                <div className="text-xs text-cream-30 font-mono tabular-nums">
                  in {fmtBps(m.inBps)} · out {fmtBps(m.outBps)}
                </div>
              </div>

              <div className="col-span-5 sm:col-span-2 text-right tabular-nums font-mono">
                <div className="text-cream-80">{m.validatorCount}</div>
                <div className="text-xs text-cream-30">
                  {fmtSol(m.stakeSol)} SOL
                </div>
              </div>

              <div className="hidden sm:block sm:col-span-2 text-right tabular-nums font-mono text-cream-60">
                {fmtBps(m.capacityBps)}
                <div className="text-xs text-cream-30">
                  {m.linkCount} link{m.linkCount === 1 ? "" : "s"}
                </div>
              </div>

              <div className="hidden sm:flex sm:col-span-1 justify-end items-center gap-0.5">
                {m.contributors.slice(0, 5).map((code) => (
                  <span
                    key={code}
                    title={code}
                    className="size-2 rounded-full"
                    style={{ backgroundColor: getContributorColor(code) }}
                  />
                ))}
                {m.contributors.length > 5 && (
                  <span className="text-xs text-cream-30 ml-0.5">
                    +{m.contributors.length - 5}
                  </span>
                )}
              </div>

              {/* Mobile-only: stake bar (replaces capacity column) */}
              <div className="col-span-12 sm:hidden">
                <div className="h-0.5 bg-cream-8 overflow-hidden">
                  <div
                    className="h-full bg-cream-30"
                    style={{ width: `${stakePct}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {sorted.length > 8 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-border px-4 py-2 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono hover:text-foreground hover:bg-surface-2/40 transition-colors"
        >
          {expanded ? "Collapse" : `Show all ${sorted.length} metros`}
        </button>
      )}
    </div>
  );
}
