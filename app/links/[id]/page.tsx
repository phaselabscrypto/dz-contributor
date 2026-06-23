"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { useLiveTopology, useLiveStatus } from "@/lib/hooks/use-live";
import {
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import { AlertTriangle, Loader2 } from "lucide-react";
import { LoadingState, EmptyState } from "@/components/ui/states";
import { useEpochs } from "@/lib/hooks/use-epochs";
import {
  useLinkEstimate,
  canonicalByMetroPair,
  metroPairKey,
} from "@/lib/hooks/use-link-estimate";
import { fmtBps } from "@/lib/utils/format";


export default function LinkDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { data: topology, isLoading } = useLiveTopology();
  const { data: status } = useLiveStatus();
  const { data: epochsData } = useEpochs();

  const link = useMemo(
    () => topology?.links.find((l) => l.pk === id),
    [topology, id],
  );
  const issues = useMemo(
    () =>
      (status?.issues ?? []).filter(
        (i) => link && i.code === link.code,
      ),
    [status, link],
  );
  const utilEntry = useMemo(
    () => (status?.topUtilLinks ?? []).find((t) => t.pk === id),
    [status, id],
  );

  // Where does this link rank within its contributor's set? Canonical
  // per-link Shapley (epoch precompute cache / job / hard error).
  const latestEpoch = epochsData?.latest ?? null;
  const canonical = useLinkEstimate(link?.contributorCode ?? null, latestEpoch);
  const valueRow = useMemo(() => {
    if (!link || !canonical.data) return null;
    const canon = canonicalByMetroPair(canonical.data.links).get(
      metroPairKey(link.sideAMetro, link.sideZMetro),
    );
    if (!canon) return null;
    const total = canonical.data.links.reduce(
      (s, l) => s + Math.max(l.value, 0),
      0,
    );
    const percent = total > 0 ? (Math.max(canon.value, 0) / total) * 100 : 0;
    const tier: "High" | "Medium" | "Low" =
      percent >= 25 ? "High" : percent >= 8 ? "Medium" : "Low";
    return { percent, tier };
  }, [link, canonical.data]);

  if (isLoading || !topology) {
    return (
      <>
        <PageHeader title="Loading…" description="Fetching link details" />
        <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
          <LoadingState label="Loading link" />
        </div>
      </>
    );
  }

  if (!link) {
    return (
      <>
        <PageHeader title="Link not found" description={id} />
        <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
          <EmptyState
            title="No live link with that pubkey"
            message="It may have been retired, or the pubkey is wrong."
            action={
              <Link
                href="/links"
                className="border border-border bg-surface px-3 py-1.5 text-xs uppercase tracking-[0.14em] font-mono hover:bg-surface-2/40 transition-colors"
              >
                ← Back to links
              </Link>
            }
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={link.code}
        description={`${link.sideAMetro.toUpperCase()} → ${link.sideZMetro.toUpperCase()} · ${getContributorDisplayName(link.contributorCode)}`}
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6 space-y-6">
        <Link
          href="/links"
          className="inline-flex items-center text-sm text-cream-60 hover:text-cream-80 transition-colors"
        >
          ← All links
        </Link>

        {/* Headline metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px border border-border bg-border">
          <Stat label="Bandwidth" value={fmtBps(link.bandwidthBps)} numeric={false} />
          <Stat
            label="Latency"
            value={
              link.latencyUs > 0 ? `${(link.latencyUs / 1000).toFixed(2)} ms` : "—"
            }
            numeric={false}
          />
          <Stat
            label="Loss"
            value={link.lossPercent > 0 ? `${link.lossPercent.toFixed(2)}%` : "0%"}
            numeric={false}
          />
          <Stat
            label="Status"
            value={link.status}
            numeric={false}
            tone={link.status === "activated" ? "ok" : "warn"}
          />
        </div>

        {/* Canonical value-add ranking within the contributor's link set:
            loading, error, value, or explicit no-row. */}
        <div className="border border-border bg-surface">
          <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
              Value-add
            </span>
            <Link
              href={`/link-value?contributor=${encodeURIComponent(link.contributorCode)}`}
              className="text-xs text-muted-foreground hover:text-foreground font-mono underline decoration-dotted"
            >
              full breakdown ›
            </Link>
          </div>
          {canonical.loading ? (
            <div className="px-4 py-3 flex items-center gap-2 text-sm text-cream-60">
              <Loader2 className="size-3.5 animate-spin shrink-0" />
              <span>
                Calculating
                {typeof canonical.progress === "number" &&
                canonical.progress > 0
                  ? ` — ${Math.round(canonical.progress)}%`
                  : "…"}
              </span>
            </div>
          ) : canonical.error ? (
            <div className="px-4 py-3 flex items-start gap-2 text-xs text-amber-300">
              <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
              <span>
                Value unavailable: {canonical.error.slice(0, 160)}
              </span>
            </div>
          ) : valueRow ? (
            <>
              <div className="px-4 py-3 grid grid-cols-3 gap-3 items-center text-sm">
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                    Tier
                  </div>
                  <div
                    className={
                      valueRow.tier === "High"
                        ? "mt-1 font-medium text-emerald-300"
                        : valueRow.tier === "Medium"
                        ? "mt-1 font-medium text-amber-300"
                        : "mt-1 font-medium text-cream-40"
                    }
                  >
                    {valueRow.tier}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                    Share of contributor
                  </div>
                  <div className="mt-1 font-mono tabular-nums">
                    {valueRow.percent.toFixed(1)}%
                  </div>
                </div>
                <div className="hidden sm:block">
                  <div className="h-1.5 bg-cream-8 overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${Math.min(valueRow.percent * 1.5, 100)}%`,
                        backgroundColor: getContributorColor(link.contributorCode),
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground font-mono">
                Epoch {canonical.data?.epoch ?? "—"}
              </div>
            </>
          ) : canonical.data ? (
            <div className="px-4 py-3 text-xs text-cream-40">
              No value available for this link in epoch {canonical.data.epoch}.
            </div>
          ) : null}
        </div>

        {/* Active utilization */}
        {utilEntry && (
          <div className="border border-border bg-surface p-4">
            <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono mb-2">
              Active utilization
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <UtilBar label="Inbound" pct={utilEntry.utilizationIn * 100} bps={utilEntry.inBps} cap={utilEntry.bandwidthBps} />
              <UtilBar label="Outbound" pct={utilEntry.utilizationOut * 100} bps={utilEntry.outBps} cap={utilEntry.bandwidthBps} />
            </div>
          </div>
        )}

        {/* Issues */}
        {issues.length > 0 && (
          <div className="border border-amber-500/30 bg-amber-500/5">
            <div className="border-b border-amber-500/20 px-4 py-2.5 flex items-center gap-2">
              <AlertTriangle className="size-3.5 text-amber-400" />
              <span className="text-xs uppercase tracking-[0.14em] text-amber-300 font-mono">
                Active issues ({issues.length})
              </span>
            </div>
            <div className="divide-y divide-amber-500/10 text-xs">
              {issues.map((i, idx) => (
                <div
                  key={`${i.issue}-${idx}`}
                  className="px-4 py-2 flex items-center justify-between gap-3"
                >
                  <span className="text-amber-300 capitalize">
                    {i.issue.replace(/_/g, " ")}
                  </span>
                  <span className="font-mono text-cream-40">
                    threshold {i.threshold} · value {i.value} · since{" "}
                    {new Date(i.since).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Endpoints */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card title="Side A">
            <Row label="Metro" value={link.sideAMetro.toUpperCase()} />
            <Row label="Device code" value={link.sideACode} mono />
            <Row label="Device pubkey" value={link.sideAPk} mono small />
          </Card>
          <Card title="Side Z">
            <Row label="Metro" value={link.sideZMetro.toUpperCase()} />
            <Row label="Device code" value={link.sideZCode} mono />
            <Row label="Device pubkey" value={link.sideZPk} mono small />
          </Card>
        </div>

        {/* Contributor */}
        <div className="border border-border bg-surface p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="size-3 rounded-full shrink-0"
              style={{
                backgroundColor: getContributorColor(link.contributorCode),
              }}
            />
            <div className="min-w-0">
              <div className="font-medium">
                {getContributorDisplayName(link.contributorCode)}
              </div>
              <div className="text-xs font-mono text-cream-30">
                {link.contributorCode}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link
              href={`/contributors/${link.contributorCode}`}
              className="text-xs px-3 py-1.5 border border-border hover:bg-surface-2/40 transition-colors"
            >
              View contributor
            </Link>
            <Link
              href={`/simulate?contributor=${encodeURIComponent(link.contributorCode)}`}
              className="text-xs px-3 py-1.5 border border-primary bg-primary text-primary-foreground hover:opacity-90 inline-flex items-center gap-1.5 font-mono uppercase tracking-[0.14em]"
            >
              Forecast →
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  numeric = true,
  tone,
}: {
  label: string;
  value: number | string;
  numeric?: boolean;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-mono tabular-nums ${
          tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : ""
        }`}
      >
        {numeric && typeof value === "number"
          ? value.toLocaleString()
          : value}
      </div>
    </div>
  );
}

function UtilBar({
  label,
  pct,
  bps,
  cap,
}: {
  label: string;
  pct: number;
  bps: number;
  cap: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1.5 font-mono">
        <span className="text-cream-40">{label}</span>
        <span className="text-cream-60 tabular-nums">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 bg-cream-8 overflow-hidden">
        <div
          className={`h-full ${
            pct > 70 ? "bg-amber-400" : pct > 30 ? "bg-emerald-400" : "bg-cream-30"
          }`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="text-xs font-mono text-cream-30 mt-1 tabular-nums">
        {fmtBps(bps)} of {fmtBps(cap)}
      </div>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {title}
      </div>
      <div className="p-4 space-y-2 text-sm">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-cream-40 text-xs">{label}</span>
      <span
        className={`${mono ? "font-mono" : ""} ${
          small ? "text-xs text-cream-60 truncate" : "text-cream-80"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
