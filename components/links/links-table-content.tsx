"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useLiveTopology, useLiveStatus } from "@/lib/hooks/use-live";
import {
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import { Search, Download } from "lucide-react";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";
import { LoadingState, ErrorState } from "@/components/ui/states";
import { useLocalStorageState } from "@/lib/hooks/use-local-storage";

function fmtBps(bps: number): string {
  if (bps >= 1e12) return `${(bps / 1e12).toFixed(1)}T`;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(0)}G`;
  return `${(bps / 1e6).toFixed(0)}M`;
}
function fmtMs(us: number): string {
  if (us === 0) return "—";
  return `${(us / 1000).toFixed(2)}`;
}

type SortKey =
  | "code"
  | "contributor"
  | "sideA"
  | "sideZ"
  | "type"
  | "bw"
  | "lat"
  | "loss"
  | "util"
  | "status";

export default function LinksTableContent() {
  const { data: topology, isLoading, error, mutate } = useLiveTopology();
  const { data: status } = useLiveStatus();
  const [query, setQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterContributor, setFilterContributor] = useState<string>("all");
  const [sortState, setSortState] = useLocalStorageState<{
    key: SortKey;
    dir: "asc" | "desc";
  }>("dz.links.sort", { key: "contributor", dir: "asc" });
  const sort = sortState.key;
  const dir = sortState.dir;

  const utilByPk = useMemo(() => {
    const m = new Map<string, number>();
    if (status) {
      for (const t of status.topUtilLinks) {
        m.set(t.pk, Math.max(t.utilizationIn, t.utilizationOut));
      }
    }
    return m;
  }, [status]);

  const linkTypes = useMemo(() => {
    if (!topology) return [];
    return Array.from(new Set(topology.links.map((l) => l.linkType))).sort();
  }, [topology]);

  const contributorOptions = useMemo(() => {
    if (!topology) return [];
    return [...topology.contributors]
      .filter((c) => c.linkCount > 0)
      .sort((a, b) => b.linkCount - a.linkCount);
  }, [topology]);

  const filtered = useMemo(() => {
    if (!topology) return [];
    let list = topology.links;
    if (filterType !== "all") {
      list = list.filter((l) => l.linkType === filterType);
    }
    if (filterContributor !== "all") {
      list = list.filter((l) => l.contributorCode === filterContributor);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (l) =>
          l.code.toLowerCase().includes(q) ||
          l.sideAMetro.toLowerCase().includes(q) ||
          l.sideZMetro.toLowerCase().includes(q) ||
          l.contributorCode.toLowerCase().includes(q) ||
          getContributorDisplayName(l.contributorCode)
            .toLowerCase()
            .includes(q),
      );
    }
    const m = dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = (() => {
        switch (sort) {
          case "code":
            return a.code;
          case "contributor":
            return a.contributorCode;
          case "sideA":
            return a.sideAMetro;
          case "sideZ":
            return a.sideZMetro;
          case "type":
            return a.linkType;
          case "bw":
            return a.bandwidthBps;
          case "lat":
            return a.latencyUs;
          case "loss":
            return a.lossPercent;
          case "util":
            return utilByPk.get(a.pk) ?? 0;
          case "status":
            return a.status;
        }
      })();
      const bv = (() => {
        switch (sort) {
          case "code":
            return b.code;
          case "contributor":
            return b.contributorCode;
          case "sideA":
            return b.sideAMetro;
          case "sideZ":
            return b.sideZMetro;
          case "type":
            return b.linkType;
          case "bw":
            return b.bandwidthBps;
          case "lat":
            return b.latencyUs;
          case "loss":
            return b.lossPercent;
          case "util":
            return utilByPk.get(b.pk) ?? 0;
          case "status":
            return b.status;
        }
      })();
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * m;
      return String(av).localeCompare(String(bv)) * m;
    });
  }, [topology, query, filterType, filterContributor, sort, dir, utilByPk]);

  if (error && !topology) {
    return (
      <ErrorState
        title="Couldn't load links"
        message={(error as Error).message}
        onRetry={() => mutate()}
      />
    );
  }
  if (isLoading || !topology) {
    return <LoadingState label="Fetching links" />;
  }

  const toggleSort = (key: SortKey) => {
    setSortState((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 border border-border bg-surface px-3 py-2 flex-1 min-w-[180px] sm:min-w-[260px]">
          <Search className="size-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by code, metro, contributor…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="border border-border bg-surface px-3 py-2 text-sm font-mono"
        >
          <option value="all">All types</option>
          {linkTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={filterContributor}
          onChange={(e) => setFilterContributor(e.target.value)}
          className="border border-border bg-surface px-3 py-2 text-sm font-mono"
        >
          <option value="all">All contributors</option>
          {contributorOptions.map((c) => (
            <option key={c.code} value={c.code}>
              {getContributorDisplayName(c.code)} ({c.linkCount})
            </option>
          ))}
        </select>
        <span className="text-xs font-mono text-muted-foreground">
          {filtered.length} of {topology.links.length}
        </span>
        <button
          type="button"
          onClick={() => {
            const headers = [
              "Code",
              "PK",
              "Status",
              "Type",
              "Side A metro",
              "Side A device",
              "Side Z metro",
              "Side Z device",
              "Contributor",
              "Bandwidth (bps)",
              "Latency (us)",
              "Jitter (us)",
              "Loss %",
              "In bps",
              "Out bps",
            ];
            const rows = filtered.map((l) => [
              l.code,
              l.pk,
              l.status,
              l.linkType,
              l.sideAMetro,
              l.sideACode,
              l.sideZMetro,
              l.sideZCode,
              l.contributorCode,
              l.bandwidthBps,
              l.latencyUs,
              l.jitterUs,
              l.lossPercent,
              l.inBps,
              l.outBps,
            ]);
            downloadCsv(
              `dz-links-${new Date().toISOString().slice(0, 10)}.csv`,
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
              <Th label="Code" k="code" sort={sort} dir={dir} onSort={toggleSort} className="hidden sm:table-cell" />
              <Th label="Contributor" k="contributor" sort={sort} dir={dir} onSort={toggleSort} className="hidden lg:table-cell" />
              <Th label="A → Z" k="sideA" sort={sort} dir={dir} onSort={toggleSort} />
              <Th label="Side Z" k="sideZ" sort={sort} dir={dir} onSort={toggleSort} className="hidden md:table-cell" />
              <Th label="Type" k="type" sort={sort} dir={dir} onSort={toggleSort} className="hidden lg:table-cell" />
              <Th label="BW" k="bw" align="right" sort={sort} dir={dir} onSort={toggleSort} />
              <Th label="Lat (ms)" k="lat" align="right" sort={sort} dir={dir} onSort={toggleSort} className="hidden md:table-cell" />
              <Th label="Loss" k="loss" align="right" sort={sort} dir={dir} onSort={toggleSort} className="hidden lg:table-cell" />
              <Th label="Util" k="util" align="right" sort={sort} dir={dir} onSort={toggleSort} className="hidden sm:table-cell" />
              <Th label="Status" k="status" sort={sort} dir={dir} onSort={toggleSort} className="hidden xl:table-cell" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => {
              const util = utilByPk.get(l.pk);
              return (
                <tr
                  key={l.pk}
                  className="border-b border-border last:border-b-0 hover:bg-surface-2/40"
                >
                  <td className="hidden sm:table-cell px-3 py-2 font-mono text-xs text-cream-60 truncate max-w-[16rem]">
                    <Link
                      href={`/links/${l.pk}`}
                      className="hover:text-foreground"
                    >
                      {l.code}
                    </Link>
                  </td>
                  <td className="hidden lg:table-cell px-3 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="size-2 rounded-full"
                        style={{
                          backgroundColor: getContributorColor(l.contributorCode),
                        }}
                      />
                      {getContributorDisplayName(l.contributorCode)}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono">
                    <Link
                      href={`/links/${l.pk}`}
                      className="hover:text-foreground sm:hidden"
                    >
                      {l.sideAMetro.toUpperCase()}{" "}
                      <span className="text-cream-30">→</span>{" "}
                      {l.sideZMetro.toUpperCase()}
                    </Link>
                    <span className="hidden sm:inline md:hidden">
                      {l.sideAMetro.toUpperCase()}{" "}
                      <span className="text-cream-30">→</span>{" "}
                      {l.sideZMetro.toUpperCase()}
                    </span>
                    <span className="hidden md:inline">
                      {l.sideAMetro.toUpperCase()}
                    </span>
                  </td>
                  <td className="hidden md:table-cell px-3 py-2 font-mono">
                    {l.sideZMetro.toUpperCase()}
                  </td>
                  <td className="hidden lg:table-cell px-3 py-2 text-xs text-cream-60">
                    {l.linkType}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono">
                    {fmtBps(l.bandwidthBps)}
                  </td>
                  <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums font-mono">
                    {fmtMs(l.latencyUs)}
                  </td>
                  <td className="hidden lg:table-cell px-3 py-2 text-right tabular-nums font-mono">
                    {l.lossPercent > 0
                      ? `${l.lossPercent.toFixed(2)}%`
                      : "0%"}
                  </td>
                  <td className="hidden sm:table-cell px-3 py-2 text-right tabular-nums font-mono">
                    {util !== undefined ? `${(util * 100).toFixed(0)}%` : "—"}
                  </td>
                  <td className="hidden xl:table-cell px-3 py-2">
                    <span
                      className={
                        l.status === "activated"
                          ? "text-emerald-400 text-xs"
                          : "text-amber-400 text-xs"
                      }
                    >
                      {l.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="border border-border bg-surface p-12 text-center text-sm text-muted-foreground">
          No links match.
        </div>
      )}
    </div>
  );
}

function Th({
  label,
  k,
  sort,
  dir,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  k: SortKey;
  sort: SortKey;
  dir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort === k;
  return (
    <th
      className={`px-3 py-2 font-normal cursor-pointer select-none hover:text-foreground transition-colors ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
      onClick={() => onSort(k)}
    >
      {label}
      {active && (
        <span className="ml-1 text-cream-60">{dir === "asc" ? "↑" : "↓"}</span>
      )}
    </th>
  );
}
