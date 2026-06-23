"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  useLiveTopology,
  useEconomicHub,
  useBaselineShapley,
} from "@/lib/hooks/use-live";
import { PageHeader } from "@/components/ui/page-header";
import {
  ehNameToCode,
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import { Search, ArrowRight, Download } from "lucide-react";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";
import { fmtBps } from "@/lib/utils/format";
import { useLocalStorageState } from "@/lib/hooks/use-local-storage";
import {
  LoadingState,
  ErrorState,
  EmptyState,
  TableSkeleton,
  Skeleton,
} from "@/components/ui/states";


type SortKey =
  | "name"
  | "devices"
  | "links"
  | "metros"
  | "validators"
  | "bandwidth"
  | "live"
  | "alltime";

export default function ContributorsPage() {
  const { data: topology, isLoading, error, mutate } = useLiveTopology();
  const { data: hub } = useEconomicHub();
  const { data: baseline } = useBaselineShapley();
  const [query, setQuery] = useState("");
  const [sortState, setSortState] = useLocalStorageState<{
    key: SortKey;
    dir: "asc" | "desc";
  }>("dz.contributors.sort", { key: "alltime", dir: "desc" });
  const sortKey = sortState.key;
  const sortDir = sortState.dir;

  const toggleSort = (key: SortKey) => {
    setSortState((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" },
    );
  };

  const enriched = useMemo(() => {
    if (!topology) return [];
    const ehMap = new Map<string, number>();
    if (hub) {
      for (const c of hub.contributors) {
        ehMap.set(ehNameToCode(c.name), c.rewardPercentage);
      }
    }
    return topology.contributors.map((c) => {
      const rewardPct = ehMap.get(c.code) ?? 0;
      const livePct = baseline?.values?.[c.code]?.share
        ? baseline.values[c.code].share * 100
        : 0;
      return { ...c, rewardPct, livePct };
    });
  }, [topology, hub, baseline]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = enriched;
    if (q) {
      list = enriched.filter((c) => {
        if (c.code.toLowerCase().includes(q)) return true;
        if (getContributorDisplayName(c.code).toLowerCase().includes(q))
          return true;
        if (c.metros.some((m) => m.toLowerCase().includes(q))) return true;
        return false;
      });
    }
    const dirMul = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case "name":
          av = getContributorDisplayName(a.code).toLowerCase();
          bv = getContributorDisplayName(b.code).toLowerCase();
          return av < bv ? -1 * dirMul : av > bv ? 1 * dirMul : 0;
        case "devices":
          av = a.deviceCount; bv = b.deviceCount; break;
        case "links":
          av = a.linkCount; bv = b.linkCount; break;
        case "metros":
          av = a.metros.length; bv = b.metros.length; break;
        case "validators":
          av = a.validatorCount ?? 0; bv = b.validatorCount ?? 0; break;
        case "bandwidth":
          av = a.totalBandwidthBps; bv = b.totalBandwidthBps; break;
        case "live":
          av = a.livePct; bv = b.livePct; break;
        case "alltime":
        default:
          av = a.rewardPct; bv = b.rewardPct; break;
      }
      return ((av as number) - (bv as number)) * dirMul;
    });
  }, [enriched, query, sortKey, sortDir]);

  return (
    <>
      <PageHeader
        title="Contributors"
        description="Live operator footprint on DoubleZero — devices, links, metros, and historic reward share."
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
        {error && !topology ? (
          <ErrorState
            title="Couldn't load contributors"
            message={(error as Error).message}
            onRetry={() => mutate()}
          />
        ) : isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-9 w-full" />
            <TableSkeleton rows={10} columns={5} />
          </div>
        ) : enriched.length === 0 ? (
          <EmptyState
            title="No contributors visible"
            message="Upstream returned an empty topology. Try again in a minute."
          />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 border border-border bg-surface px-3 py-2">
              <Search className="size-4 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by code, name, or metro…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  clear
                </button>
              )}
              <span className="text-xs font-mono tabular-nums text-muted-foreground">
                {filtered.length} of {enriched.length}
              </span>
              <button
                type="button"
                onClick={() => {
                  const headers = [
                    "Code",
                    "Name",
                    "Devices",
                    "Links",
                    "Metros",
                    "Validators",
                    "Bandwidth (bps)",
                    "Live Shapley share %",
                    "All-time payout share %",
                  ];
                  const rows = filtered.map((c) => [
                    c.code,
                    getContributorDisplayName(c.code),
                    c.deviceCount,
                    c.linkCount,
                    c.metros.length,
                    c.validatorCount,
                    c.totalBandwidthBps,
                    c.livePct.toFixed(6),
                    c.rewardPct.toFixed(6),
                  ]);
                  downloadCsv(
                    `dz-contributors-${new Date().toISOString().slice(0, 10)}.csv`,
                    rowsToCsv(headers, rows),
                  );
                }}
                className="inline-flex items-center gap-1.5 text-xs font-mono uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground transition-colors"
                title="Export CSV"
              >
                <Download className="size-3" />
                CSV
              </button>
            </div>

            <div className="border border-border bg-surface overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                    <Th align="left" sortKey="name" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort}>Contributor</Th>
                    <Th align="right" className="hidden sm:table-cell" sortKey="devices" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort}>Devices</Th>
                    <Th align="right" sortKey="links" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort}>Links</Th>
                    <Th align="right" className="hidden md:table-cell" sortKey="metros" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort}>Metros</Th>
                    <Th align="right" className="hidden lg:table-cell" sortKey="validators" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort}>Validators</Th>
                    <Th align="right" className="hidden md:table-cell" sortKey="bandwidth" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort}>Bandwidth</Th>
                    <Th align="right" className="hidden lg:table-cell" sortKey="live" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort}>Live share</Th>
                    <Th align="right" sortKey="alltime" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort}>All-time</Th>
                    <Th align="left" className="hidden sm:table-cell">&nbsp;</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr
                      key={c.code}
                      className="border-b border-border last:border-b-0 hover:bg-surface-2/40 cursor-pointer"
                      onClick={() => {
                        window.location.href = `/contributors/${c.code}`;
                      }}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="size-2 rounded-full shrink-0"
                            style={{
                              backgroundColor: getContributorColor(c.code),
                            }}
                          />
                          <span className="font-medium truncate">
                            {getContributorDisplayName(c.code)}
                          </span>
                          <span className="hidden sm:inline text-xs font-mono text-cream-30">
                            {c.code}
                          </span>
                        </div>
                      </td>
                      <td className="hidden sm:table-cell px-3 py-2.5 text-right tabular-nums font-mono">
                        {c.deviceCount}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-mono">
                        {c.linkCount}
                      </td>
                      <td className="hidden md:table-cell px-3 py-2.5 text-right tabular-nums font-mono">
                        {c.metros.length}
                      </td>
                      <td className="hidden lg:table-cell px-3 py-2.5 text-right tabular-nums font-mono">
                        {c.validatorCount || "—"}
                      </td>
                      <td className="hidden md:table-cell px-3 py-2.5 text-right tabular-nums font-mono">
                        {fmtBps(c.totalBandwidthBps)}
                      </td>
                      <td className="hidden lg:table-cell px-3 py-2.5 text-right tabular-nums font-mono text-emerald-300/80">
                        {c.livePct > 0
                          ? `${c.livePct.toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-mono">
                        {c.rewardPct > 0
                          ? `${c.rewardPct.toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="hidden sm:table-cell px-3 py-2.5">
                        <Link
                          href={`/contributors/${c.code}`}
                          className="text-cream-30 hover:text-foreground inline-flex"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ArrowRight className="size-4" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && query && (
                <div className="border-t border-border px-4 py-8 text-center text-xs text-muted-foreground font-mono">
                  No contributors match &ldquo;{query}&rdquo;.
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground font-mono">
              Reward share = all-time % of distributed 2Z pool from{" "}
              <a
                href="https://doublezero.xyz/api/economic-hub"
                className="underline decoration-dotted hover:text-foreground"
                target="_blank"
                rel="noreferrer"
              >
                economic-hub
              </a>
              . Devices/links/metros from{" "}
              <a
                href="https://data.malbeclabs.com/api/topology"
                className="underline decoration-dotted hover:text-foreground"
                target="_blank"
                rel="noreferrer"
              >
                malbec/topology
              </a>
              .
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function Th({
  children,
  align = "left",
  className = "",
  sortKey,
  currentKey,
  currentDir,
  onSort,
}: {
  children: React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  sortKey?: SortKey;
  currentKey?: SortKey;
  currentDir?: "asc" | "desc";
  onSort?: (k: SortKey) => void;
}) {
  const isActive = sortKey && currentKey === sortKey;
  const clickable = !!sortKey && !!onSort;
  const indicator = isActive
    ? currentDir === "asc"
      ? " ↑"
      : " ↓"
    : "";
  return (
    <th
      className={`px-3 py-2 font-normal ${
        align === "right"
          ? "text-right"
          : align === "center"
          ? "text-center"
          : "text-left"
      } ${className} ${
        clickable
          ? "cursor-pointer select-none hover:text-foreground transition-colors"
          : ""
      }`}
      onClick={clickable ? () => onSort!(sortKey!) : undefined}
    >
      {children}
      {indicator && (
        <span className="ml-1 text-cream-60">{indicator}</span>
      )}
    </th>
  );
}
