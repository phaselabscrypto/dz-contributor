"use client";

import { useMemo } from "react";
import { useLocalStorageState } from "@/lib/hooks/use-local-storage";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useLiveTopology, useLiveStatus } from "@/lib/hooks/use-live";
import { PageHeader } from "@/components/ui/page-header";
import {
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import { LoadingState, EmptyState, ErrorState } from "@/components/ui/states";
import { AlertTriangle, ArrowRight, ArrowLeft, Download, Loader2 } from "lucide-react";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";
import { fmtBps } from "@/lib/utils/format";
import { useEpochs } from "@/lib/hooks/use-epochs";
import {
  useLinkEstimate,
  canonicalByMetroPair,
  metroPairKey,
} from "@/lib/hooks/use-link-estimate";


function fmtMs(us: number): string {
  return `${(us / 1000).toFixed(1)}ms`;
}

type SortKey = "code" | "sideA" | "sideZ" | "type" | "bw" | "lat" | "tier" | "status";

export default function ContributorLinksPage() {
  const params = useParams();
  const code = params.code as string;
  const { data: topology, isLoading, error, mutate } = useLiveTopology();
  const { data: status } = useLiveStatus();
  const [sortState, setSortState] = useLocalStorageState<{
    key: SortKey;
    dir: "asc" | "desc";
  }>("dz.contributor-links.sort", { key: "tier", dir: "desc" });
  const sort = sortState.key;
  const dir = sortState.dir;

  const links = useMemo(
    () =>
      (topology?.links ?? []).filter((l) => l.contributorCode === code),
    [topology, code],
  );

  // Canonical per-link values only (epoch precompute cache / job / hard error)
  // — Tier/Value columns show "—" until the canonical run lands; never an
  // estimate.
  const { data: epochsData } = useEpochs();
  const latestEpoch = epochsData?.latest ?? null;
  const canonical = useLinkEstimate(code ?? null, latestEpoch);

  const valueRows = useMemo(() => {
    const m = new Map<string, { tier: string; percent: number }>();
    if (!canonical.data) return m;
    const byPair = canonicalByMetroPair(canonical.data.links);
    const total = canonical.data.links.reduce(
      (s, l) => s + Math.max(l.value, 0),
      0,
    );
    for (const l of links) {
      const canon = byPair.get(metroPairKey(l.sideAMetro, l.sideZMetro));
      if (!canon) continue;
      const percent = total > 0 ? (Math.max(canon.value, 0) / total) * 100 : 0;
      const tier = percent >= 25 ? "High" : percent >= 8 ? "Medium" : "Low";
      m.set(l.pk, { tier, percent });
    }
    return m;
  }, [canonical.data, links]);

  const utilByPk = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of status?.topUtilLinks ?? []) {
      m.set(t.pk, Math.max(t.utilizationIn, t.utilizationOut));
    }
    return m;
  }, [status]);

  const tierWeight = (t: string) => (t === "High" ? 3 : t === "Medium" ? 2 : 1);

  const sorted = useMemo(() => {
    const arr = [...links];
    arr.sort((a, b) => {
      let cmp = 0;
      const va = valueRows.get(a.pk);
      const vb = valueRows.get(b.pk);
      switch (sort) {
        case "code":
          cmp = a.code.localeCompare(b.code);
          break;
        case "sideA":
          cmp = a.sideAMetro.localeCompare(b.sideAMetro);
          break;
        case "sideZ":
          cmp = a.sideZMetro.localeCompare(b.sideZMetro);
          break;
        case "type":
          cmp = a.linkType.localeCompare(b.linkType);
          break;
        case "bw":
          cmp = a.bandwidthBps - b.bandwidthBps;
          break;
        case "lat":
          cmp = a.latencyUs - b.latencyUs;
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "tier":
          cmp =
            tierWeight(va?.tier ?? "Low") - tierWeight(vb?.tier ?? "Low") ||
            (va?.percent ?? 0) - (vb?.percent ?? 0);
          break;
      }
      return dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [links, sort, dir, valueRows]);

  const toggleSort = (k: SortKey) => {
    setSortState((prev) =>
      prev.key === k
        ? { key: k, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key: k, dir: k === "tier" || k === "bw" ? "desc" : "asc" },
    );
  };

  if (error && !topology) {
    return (
      <>
        <PageHeader title="Loading…" description={code} />
        <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
          <ErrorState
            title="Couldn't load links"
            message={(error as Error).message}
            onRetry={() => mutate()}
          />
        </div>
      </>
    );
  }
  if (isLoading || !topology) {
    return (
      <>
        <PageHeader title="Loading…" description={code} />
        <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
          <LoadingState label="Fetching links" />
        </div>
      </>
    );
  }

  const displayName = getContributorDisplayName(code);
  const color = getContributorColor(code);
  const totalBw = links.reduce((s, l) => s + l.bandwidthBps, 0);

  return (
    <>
      <PageHeader
        title={`${displayName} links`}
        description={`Full link footprint for ${code} with per-link value-add tier and live utilization.`}
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Link
            href={`/contributors/${code}`}
            className="inline-flex items-center gap-1.5 text-sm text-cream-60 hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-4" />
            Back to {displayName}
          </Link>
          <button
            onClick={() => {
              const headers = [
                "Code",
                "Side A",
                "Side Z",
                "Type",
                "Bandwidth (bps)",
                "Latency (us)",
                "Loss %",
                "Tier",
                "Value %",
                "Utilization %",
                "Status",
              ];
              const rows = sorted.map((l) => {
                const v = valueRows.get(l.pk);
                const u = utilByPk.get(l.pk);
                return [
                  l.code,
                  l.sideAMetro,
                  l.sideZMetro,
                  l.linkType,
                  l.bandwidthBps,
                  l.latencyUs,
                  l.lossPercent,
                  v?.tier ?? "—",
                  v?.percent.toFixed(2) ?? "—",
                  u !== undefined ? (u * 100).toFixed(1) : "—",
                  l.status,
                ];
              });
              downloadCsv(
                `dz-${code}-links-${new Date().toISOString().slice(0, 10)}.csv`,
                rowsToCsv(headers, rows),
              );
            }}
            className="inline-flex items-center gap-1.5 text-xs font-mono uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground transition-colors"
          >
            <Download className="size-3.5" />
            Export CSV
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px border border-border bg-border">
          <Stat label="Links" value={links.length.toString()} />
          <Stat
            label="Active"
            value={links.filter((l) => l.status === "activated").length.toString()}
          />
          <Stat label="Bandwidth" value={fmtBps(totalBw)} />
          <Stat
            label="Color"
            value={
              <span className="inline-flex items-center gap-2">
                <span
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-xs font-mono">{code}</span>
              </span>
            }
          />
        </div>

        {canonical.loading && (
          <div className="border border-border bg-surface px-3 py-2 flex items-center gap-2 text-xs text-cream-60">
            <Loader2 className="size-3.5 animate-spin shrink-0" />
            <span>
              Calculating link values
              {typeof canonical.progress === "number" && canonical.progress > 0
                ? ` — ${Math.round(canonical.progress)}%`
                : "…"}{" "}
              The Tier column will fill in when done.
            </span>
          </div>
        )}
        {canonical.error && (
          <div className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 flex items-start gap-2 text-xs text-amber-300">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
            <span>
              Link values couldn&apos;t be loaded:{" "}
              {canonical.error.slice(0, 160)}
            </span>
          </div>
        )}

        {sorted.length === 0 ? (
          <EmptyState
            title="No links"
            message="This contributor has devices but no active links in the live topology."
          />
        ) : (
          <div className="border border-border bg-surface overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                  <Th label="Code" k="code" sort={sort} dir={dir} onSort={toggleSort} />
                  <Th label="Side A" k="sideA" sort={sort} dir={dir} onSort={toggleSort} />
                  <Th label="Side Z" k="sideZ" sort={sort} dir={dir} onSort={toggleSort} />
                  <Th
                    label="Type"
                    k="type"
                    sort={sort}
                    dir={dir}
                    onSort={toggleSort}
                    align="left"
                    className="hidden md:table-cell"
                  />
                  <Th label="BW" k="bw" sort={sort} dir={dir} onSort={toggleSort} align="right" />
                  <Th
                    label="Lat"
                    k="lat"
                    sort={sort}
                    dir={dir}
                    onSort={toggleSort}
                    align="right"
                    className="hidden md:table-cell"
                  />
                  <Th label="Tier" k="tier" sort={sort} dir={dir} onSort={toggleSort} align="right" />
                  <th className="px-3 py-2 text-right hidden lg:table-cell">Util</th>
                  <Th
                    label="Status"
                    k="status"
                    sort={sort}
                    dir={dir}
                    onSort={toggleSort}
                    align="left"
                    className="hidden sm:table-cell"
                  />
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((l) => {
                  const v = valueRows.get(l.pk);
                  const u = utilByPk.get(l.pk);
                  return (
                    <tr
                      key={l.pk}
                      className="border-b border-border last:border-b-0 hover:bg-surface-2/40"
                    >
                      <td className="px-3 py-2 font-mono text-xs text-cream-60 truncate max-w-[14rem]">
                        <Link href={`/links/${l.pk}`} className="hover:text-foreground">
                          {l.code}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-mono">{l.sideAMetro.toUpperCase()}</td>
                      <td className="px-3 py-2 font-mono">{l.sideZMetro.toUpperCase()}</td>
                      <td className="hidden md:table-cell px-3 py-2 text-xs text-cream-60">
                        {l.linkType}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-mono">
                        {fmtBps(l.bandwidthBps)}
                      </td>
                      <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums font-mono">
                        {fmtMs(l.latencyUs)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {v ? (
                          <span
                            className={
                              v.tier === "High"
                                ? "text-green text-xs font-mono"
                                : v.tier === "Medium"
                                ? "text-amber text-xs font-mono"
                                : "text-cream-30 text-xs font-mono"
                            }
                          >
                            {v.tier}
                            <span className="ml-1.5 text-cream-30 tabular-nums">
                              {v.percent.toFixed(1)}%
                            </span>
                          </span>
                        ) : (
                          <span className="text-cream-20 text-xs font-mono">—</span>
                        )}
                      </td>
                      <td className="hidden lg:table-cell px-3 py-2 text-right tabular-nums font-mono text-xs">
                        {u !== undefined ? `${(u * 100).toFixed(0)}%` : "—"}
                      </td>
                      <td className="hidden sm:table-cell px-3 py-2">
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
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/links/${l.pk}`}
                          className="text-cream-30 hover:text-foreground inline-flex"
                        >
                          <ArrowRight className="size-4" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className="mt-1 text-xl font-mono tabular-nums">{value}</div>
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
