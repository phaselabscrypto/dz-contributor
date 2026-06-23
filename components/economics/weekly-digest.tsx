"use client";

import useSWR from "swr";
import Link from "next/link";
import { useEpochs } from "@/lib/hooks/use-epochs";
import { Skeleton } from "@/components/ui/states";
import { getContributorDisplayName } from "@/lib/constants/config";
import { ArrowRight, Plus, Minus } from "lucide-react";

interface DiffSummary {
  from: number;
  to: number;
  summary: {
    linksAdded: number;
    linksRemoved: number;
    linksChanged: number;
    contributorsAffected: number;
  };
  contributors: {
    code: string;
    linksAdded: number;
    linksRemoved: number;
    linksChanged: number;
    bandwidthGbpsDelta: number;
    firstSeen: boolean;
    leftNetwork: boolean;
  }[];
}

const fetcher = async (url: string): Promise<DiffSummary> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
};

function fmtGbps(gbps: number): string {
  const abs = Math.abs(gbps);
  const sign = gbps < 0 ? "-" : gbps > 0 ? "+" : "";
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)} Tbps`;
  if (abs >= 1) return `${sign}${abs.toFixed(0)} Gbps`;
  return `${sign}${(abs * 1000).toFixed(0)} Mbps`;
}

/**
 * Weekly diff digest — uses /api/diff to compare the latest snapshot to
 * one ~7 epochs back. Shipped at the top of /economics so the first
 * thing users see is "what changed since last time you looked".
 */
export function WeeklyDigest() {
  const { data: epochs } = useEpochs();
  const latest = epochs?.latest;
  const lookback = latest ? Math.max(latest - 7, 48) : null;

  const swrKey =
    latest && lookback && latest > lookback
      ? `/api/diff?from=${lookback}&to=${latest}`
      : null;
  const { data, error } = useSWR<DiffSummary>(swrKey, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5 * 60_000,
  });

  if (error) return null;

  const totalGbpsDelta =
    data?.contributors.reduce((s, c) => s + c.bandwidthGbpsDelta, 0) ?? 0;

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Recent change digest
        </span>
        {data && (
          <span className="text-xs text-muted-foreground font-mono">
            epoch {data.from} → {data.to}
          </span>
        )}
      </div>
      <div className="p-4">
        {!data ? (
          <div className="space-y-2.5">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono tabular-nums">
              <span className="inline-flex items-center gap-1.5 text-green">
                <Plus className="size-3.5" />
                {data.summary.linksAdded} link
                {data.summary.linksAdded === 1 ? "" : "s"}
              </span>
              <span className="inline-flex items-center gap-1.5 text-red">
                <Minus className="size-3.5" />
                {data.summary.linksRemoved} link
                {data.summary.linksRemoved === 1 ? "" : "s"}
              </span>
              {data.summary.linksChanged > 0 && (
                <span className="text-amber">
                  {data.summary.linksChanged} changed
                </span>
              )}
              <span
                className={
                  totalGbpsDelta >= 0 ? "text-cream-60" : "text-amber"
                }
              >
                Δ bandwidth {fmtGbps(totalGbpsDelta)}
              </span>
              <span className="text-cream-40">
                {data.summary.contributorsAffected} contributor
                {data.summary.contributorsAffected === 1 ? "" : "s"} affected
              </span>
            </div>

            {data.contributors.length > 0 && (
              <div className="space-y-1 pt-1 border-t border-border">
                <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono pt-2 pb-1">
                  Most active contributors
                </div>
                {data.contributors.slice(0, 3).map((c) => (
                  <div
                    key={c.code}
                    className="flex items-center justify-between text-xs font-mono tabular-nums gap-3"
                  >
                    <span className="text-cream-60 truncate">
                      {getContributorDisplayName(c.code)}
                      {c.firstSeen && (
                        <span className="ml-1.5 text-green text-xs uppercase tracking-[0.12em]">
                          new
                        </span>
                      )}
                      {c.leftNetwork && (
                        <span className="ml-1.5 text-red text-xs uppercase tracking-[0.12em]">
                          left
                        </span>
                      )}
                    </span>
                    <span className="text-cream-40 shrink-0">
                      {c.linksAdded > 0 && `+${c.linksAdded} `}
                      {c.linksRemoved > 0 && `−${c.linksRemoved} `}
                      {fmtGbps(c.bandwidthGbpsDelta)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <Link
              href={`/changelog?from=${data.from}&to=${data.to}`}
              className="inline-flex items-center gap-1.5 text-xs font-mono uppercase tracking-[0.12em] text-cream-40 hover:text-foreground transition-colors pt-1"
            >
              Full changelog
              <ArrowRight className="size-3" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
