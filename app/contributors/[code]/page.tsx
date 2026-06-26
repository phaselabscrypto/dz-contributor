"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  useLiveTopology,
  useEconomicHub,
  useLiveStatus,
  useBaselineShapley,
} from "@/lib/hooks/use-live";
import { usePrices } from "@/lib/hooks/use-prices";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import {
  ehNameToCode,
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import { AlertTriangle, Download } from "lucide-react";
import { LoadingState, EmptyState } from "@/components/ui/states";
import { EpochRewardHistory } from "@/components/economics/epoch-reward-history";
import { RewardReconciliation } from "@/components/contributors/reward-reconciliation";
import { ContributorChangelog } from "@/components/contributors/contributor-changelog";
import { OnchainRewardHistory } from "@/components/contributors/onchain-reward-history";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";
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

export default function ContributorDetailPage() {
  const params = useParams();
  const code = (params.code as string) ?? "";

  const { data: topology, isLoading: tl } = useLiveTopology();
  const { data: hub, isLoading: hl } = useEconomicHub();
  const { data: status } = useLiveStatus();
  const { data: baseline } = useBaselineShapley();
  const { data: prices } = usePrices();

  const contributor = topology?.contributors.find((c) => c.code === code);
  const links = useMemo(
    () => topology?.links.filter((l) => l.contributorCode === code) ?? [],
    [topology, code],
  );
  const devices = useMemo(
    () => topology?.devices.filter((d) => d.contributorCode === code) ?? [],
    [topology, code],
  );

  const ehEntry = useMemo(() => {
    if (!hub) return undefined;
    return hub.contributors.find((c) => ehNameToCode(c.name) === code);
  }, [hub, code]);

  const issues = useMemo(
    () => (status?.issues ?? []).filter((i) => i.contributor === code),
    [status, code],
  );

  if (tl || hl) {
    return (
      <>
        <PageHeader title="Loading…" description="Fetching contributor information" />
        <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
          <LoadingState label="Loading contributor" />
        </div>
      </>
    );
  }

  if (!contributor) {
    return (
      <>
        <PageHeader
          title="Contributor not found"
          description="No live record for this contributor"
        />
        <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
          <EmptyState
            title={`No contributor with code "${code}"`}
            message="It may have been retired, or the code is misspelled."
            action={
              <Link
                href="/contributors"
                className="border border-border bg-surface px-3 py-1.5 text-xs uppercase tracking-[0.14em] font-mono hover:bg-surface-2/40 transition-colors"
              >
                ← Back to contributors
              </Link>
            }
          />
        </div>
      </>
    );
  }

  const displayName = getContributorDisplayName(code);
  const color = getContributorColor(code);
  const rewardPct = ehEntry?.rewardPercentage ?? 0;
  const earned2Z = hub
    ? (rewardPct / 100) * hub.totalDistributed2Z
    : 0;
  const earnedUsd = hub
    ? (rewardPct / 100) * hub.totalDistributed2ZUsd
    : 0;
  const twoZUsd = prices?.twoZ.usdPrice ?? 0;
  const earned2ZViaUsd = twoZUsd > 0 ? earnedUsd / twoZUsd : 0;
  // Use Jupiter spot when available for sanity; otherwise hub's USD figure stands

  // Live-network Shapley share (current footing). May be 0 for operators
  // whose devices are present but have no flowing demand routed through
  // them in the live LP.
  const livePct = (baseline?.values?.[code]?.share ?? 0) * 100;
  const liveDeltaPct = livePct - rewardPct;

  // active vs degraded link counts
  const activeLinks = links.filter((l) => l.status === "activated").length;
  const totalBandwidth = links.reduce((s, l) => s + l.bandwidthBps, 0);

  return (
    <>
      <PageHeader
        title={displayName}
        description={`Operator footprint and reward share on DoubleZero (${code})`}
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/contributors"
            className="inline-flex items-center text-sm text-cream-60 hover:text-cream-80 transition-colors"
          >
            ← All contributors
          </Link>
          {hub && rewardPct > 0 && (
            <button
              type="button"
              onClick={() => {
                const avgPool2Z =
                  hub.epochs.length > 0
                    ? hub.totalDistributed2Z / hub.epochs.length
                    : 0;
                const projected2Z = (rewardPct / 100) * avgPool2Z;
                const csv = rowsToCsv(
                  ["Epoch", "Avg Pool 2Z", "Projected 2Z (all-time share)", "Share %"],
                  hub.epochs.map((ep) => [
                    ep,
                    avgPool2Z.toFixed(4),
                    projected2Z.toFixed(4),
                    rewardPct.toFixed(4),
                  ]),
                );
                downloadCsv(
                  `dz-${code}-projected-rewards-${new Date()
                    .toISOString()
                    .slice(0, 10)}.csv`,
                  csv,
                );
              }}
              className="inline-flex items-center gap-1.5 border border-border hover:border-cream-30 px-2.5 py-1.5 text-xs font-mono uppercase tracking-[0.14em] text-cream-60 hover:text-foreground transition-colors"
            >
              <Download className="size-3" />
              Export CSV
            </button>
          )}
        </div>

        <div className="border border-border bg-surface p-6">
          <div className="flex items-start justify-between mb-4 gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span
                className="size-4 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <h1 className="font-display text-2xl text-foreground truncate">
                {ehEntry?.name ?? displayName}
              </h1>
              <span className="text-xs font-mono text-cream-30">{code}</span>
            </div>
            <Badge
              variant="secondary"
              className="bg-emerald-500/10 text-emerald-300 border-emerald-500/20 text-xs"
            >
              Active
            </Badge>
          </div>

          <Link
            href={`/simulate?contributor=${encodeURIComponent(code)}`}
            className="mb-6 inline-flex items-center gap-2 border border-primary bg-primary px-3 py-1.5 text-xs font-mono uppercase tracking-[0.14em] text-primary-foreground transition-opacity hover:opacity-90"
          >
            Forecast my rewards →
          </Link>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px border border-border bg-border mb-6">
            <Stat label="Devices" value={contributor.deviceCount} />
            <Stat
              label="Links"
              value={contributor.linkCount}
              sub={`${activeLinks} active`}
            />
            <Stat label="Metros" value={contributor.metros.length} />
            <Stat label="Bandwidth" value={fmtBps(totalBandwidth)} numeric={false} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px border border-border bg-border">
            <Stat
              label="All-time reward share"
              value={
                rewardPct > 0 ? `${rewardPct.toFixed(2)}%` : "—"
              }
              numeric={false}
              sub={
                hub && rewardPct > 0
                  ? `${hub.epochs.length} distributed epochs`
                  : "no payouts yet"
              }
            />
            <Stat
              label="Live network share"
              value={livePct > 0 ? `${livePct.toFixed(2)}%` : "—"}
              numeric={false}
              sub={
                livePct > 0 && rewardPct > 0
                  ? liveDeltaPct >= 0
                    ? `+${liveDeltaPct.toFixed(2)} pts vs all-time`
                    : `${liveDeltaPct.toFixed(2)} pts vs all-time`
                  : livePct > 0
                  ? "current footing"
                  : baseline
                  ? "no demand routed"
                  : "computing…"
              }
            />
            <Stat
              label="Total 2Z earned"
              value={earned2Z > 0 ? fmtNum(earned2Z, 0) : "—"}
              numeric={false}
              sub={earnedUsd > 0 ? fmtUsd(earnedUsd) : undefined}
            />
            <Stat
              label="At spot price"
              value={
                twoZUsd > 0 && earned2ZViaUsd > 0
                  ? fmtUsd(earned2Z * twoZUsd, 0)
                  : "—"
              }
              numeric={false}
              sub={
                twoZUsd > 0
                  ? `1 2Z = ${fmtUsd(twoZUsd, 4)} (Jupiter)`
                  : undefined
              }
            />
          </div>
        </div>

        {/* Reward share reconciliation (live vs all-time) */}
        <RewardReconciliation contributorCode={code} />

        {/* Canonical on-chain reward history (DZ ledger ShapleyOutputStorage). */}
        <OnchainRewardHistory contributorCode={code} />

        {/* Footprint changelog — last ~7 epochs */}
        <ContributorChangelog code={code} />

        {/* Pool-level estimate fallback. Useful for contributors not yet
            on-chain or for users wanting the global pool view. */}
        <EpochRewardHistory contributorCode={code} />

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
                  key={`${i.code}-${idx}`}
                  className="px-4 py-2 flex items-center justify-between gap-3"
                >
                  <span className="font-mono text-cream-30 truncate">
                    {i.code}
                  </span>
                  <div className="flex items-center gap-3 shrink-0 text-cream-40 font-mono">
                    <span className="text-amber-300 capitalize">
                      {i.issue.replace(/_/g, " ")}
                    </span>
                    <span>
                      {i.sideAMetro?.toUpperCase()} →{" "}
                      {i.sideZMetro?.toUpperCase()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Links table */}
        <div className="border border-border bg-surface">
          <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
              Links ({links.length})
            </span>
            <Link
              href={`/contributors/${code}/links`}
              className="text-xs uppercase tracking-[0.12em] font-mono text-cream-40 hover:text-foreground transition-colors"
            >
              Full table + link rewards →
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                  <Th align="left" className="hidden sm:table-cell">Code</Th>
                  <Th align="left">Side A</Th>
                  <Th align="left">Side Z</Th>
                  <Th align="left" className="hidden md:table-cell">Type</Th>
                  <Th align="right">Bandwidth</Th>
                  <Th align="right" className="hidden lg:table-cell">Latency</Th>
                  <Th align="right" className="hidden lg:table-cell">Loss</Th>
                  <Th align="left">Status</Th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr
                    key={l.pk}
                    className="border-b border-border last:border-b-0 hover:bg-surface-2/40"
                  >
                    <td className="hidden sm:table-cell px-3 py-2 font-mono text-xs text-cream-60 truncate max-w-[14rem]">
                      {l.code}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {l.sideAMetro.toUpperCase()}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {l.sideZMetro.toUpperCase()}
                    </td>
                    <td className="hidden md:table-cell px-3 py-2 text-xs text-cream-60">
                      {l.linkType}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-mono">
                      {fmtBps(l.bandwidthBps)}
                    </td>
                    <td className="hidden lg:table-cell px-3 py-2 text-right tabular-nums font-mono">
                      {l.latencyUs > 0
                        ? `${(l.latencyUs / 1000).toFixed(2)}ms`
                        : "—"}
                    </td>
                    <td className="hidden lg:table-cell px-3 py-2 text-right tabular-nums font-mono">
                      {l.lossPercent > 0 ? `${l.lossPercent.toFixed(2)}%` : "0%"}
                    </td>
                    <td className="px-3 py-2">
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
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Devices table */}
        <div className="border border-border bg-surface">
          <div className="border-b border-border px-4 py-2.5 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
            Devices ({devices.length})
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                  <Th align="left" className="hidden sm:table-cell">Code</Th>
                  <Th align="left">Metro</Th>
                  <Th align="left" className="hidden md:table-cell">Type</Th>
                  <Th align="right" className="hidden md:table-cell">Users</Th>
                  <Th align="right">Validators</Th>
                  <Th align="right" className="hidden lg:table-cell">Stake (SOL)</Th>
                  <Th align="left">Status</Th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr
                    key={d.pk}
                    className="border-b border-border last:border-b-0 hover:bg-surface-2/40"
                  >
                    <td className="hidden sm:table-cell px-3 py-2 font-mono text-xs text-cream-60">
                      {d.code}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {d.metroCode.toUpperCase()}
                    </td>
                    <td className="hidden md:table-cell px-3 py-2 text-xs text-cream-60">
                      {d.deviceType}
                    </td>
                    <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums font-mono">
                      {d.userCount}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-mono">
                      {d.validatorCount}
                    </td>
                    <td className="hidden lg:table-cell px-3 py-2 text-right tabular-nums font-mono">
                      {fmtNum(d.stakeSol, 0)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          d.status === "activated"
                            ? "text-emerald-400 text-xs"
                            : "text-amber-400 text-xs"
                        }
                      >
                        {d.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  numeric = true,
}: {
  label: string;
  value: number | string;
  sub?: string;
  numeric?: boolean;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className="mt-1 text-xl font-mono tabular-nums">
        {numeric && typeof value === "number"
          ? value.toLocaleString()
          : value}
      </div>
      {sub && (
        <div className="mt-0.5 text-xs text-cream-40 font-mono">{sub}</div>
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
