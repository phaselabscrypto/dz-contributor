"use client";

import { Suspense, useMemo } from "react";
import { useQueryState, parseAsString } from "nuqs";
import Link from "next/link";
import { CheckCircle2, Info, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { useLiveTopology } from "@/lib/hooks/use-live";
import { useEpochs } from "@/lib/hooks/use-epochs";
import { LoadingState, ErrorState, EmptyState } from "@/components/ui/states";
import {
  getContributorDisplayName,
  getContributorColor,
  MAX_BREAKDOWN_FOCUS_LINKS,
} from "@/lib/constants/config";
import { linkMetaRows, type LinkMetaRow } from "@/lib/utils/link-value";
import {
  useLinkEstimate,
  canonicalByMetroPair,
  metroPairKey,
} from "@/lib/hooks/use-link-estimate";
import { fmtBps } from "@/lib/utils/format";

/** One table row: topology metadata + canonical value (null = the canonical
 * result has no row for this metro pair). */
interface DisplayRow extends LinkMetaRow {
  value: number | null;
  percent: number | null;
  tier: "High" | "Medium" | "Low" | null;
}

function Inner() {
  const { data: topology, isLoading, error, mutate } = useLiveTopology();
  const { data: epochsData } = useEpochs();
  const [contributor, setContributor] = useQueryState(
    "contributor",
    parseAsString.withDefault(""),
  );

  const contributors = useMemo(() => {
    if (!topology) return [];
    return [...topology.contributors]
      .filter((c) => c.linkCount > 0)
      .sort((a, b) => b.linkCount - a.linkCount);
  }, [topology]);

  const selected = useMemo(
    () => contributors.find((c) => c.code === contributor) ?? null,
    [contributors, contributor],
  );
  // The breakdown is an exact 2^players game (one player per link touching the
  // operator on EITHER endpoint == focusLinkCount), intractable past
  // MAX_BREAKDOWN_FOCUS_LINKS. Over-cap operators stay in the picker (hiding a
  // notable operator is more confusing than listing it), but selecting one shows
  // a calm "not available" note instead of submitting a doomed job.
  const overLinkCap =
    !!selected && selected.focusLinkCount > MAX_BREAKDOWN_FOCUS_LINKS;

  const latestEpoch = epochsData?.latest ?? null;

  // Canonical per-link Shapley — from the epoch precompute cache, or a job, or
  // a hard error. Skipped (null) when the operator is over the exact-solve cap.
  const {
    data: canonical,
    error: canonicalErr,
    terminal: canonicalTerminal,
    progress,
    loading: canonicalLoading,
  } = useLinkEstimate(
    contributor && !overLinkCap ? contributor : null,
    latestEpoch,
  );

  // Topology METADATA only (names, endpoints, specs) — never values.
  const metaRows: LinkMetaRow[] = useMemo(() => {
    if (!topology || !contributor) return [];
    return linkMetaRows(topology, contributor);
  }, [topology, contributor]);

  const rows: DisplayRow[] = useMemo(() => {
    if (!canonical) return [];
    const byPair = canonicalByMetroPair(canonical.links);
    const total = canonical.links.reduce((s, l) => s + Math.max(l.value, 0), 0);
    return metaRows
      .map((m) => {
        const canon = byPair.get(metroPairKey(m.sideAMetro, m.sideZMetro));
        if (!canon) return { ...m, value: null, percent: null, tier: null };
        const pct = total > 0 ? (Math.max(canon.value, 0) / total) * 100 : 0;
        const tier: DisplayRow["tier"] =
          pct >= 25 ? "High" : pct >= 8 ? "Medium" : "Low";
        return { ...m, value: canon.value, percent: pct, tier };
      })
      .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
  }, [canonical, metaRows]);

  const unvalued = rows.filter((r) => r.percent === null).length;

  if (error && !topology) {
    return (
      <ErrorState
        title="Couldn't load topology"
        message={(error as Error).message}
        onRetry={() => mutate()}
      />
    );
  }
  if (isLoading || !topology) {
    return <LoadingState label="Fetching links" />;
  }

  return (
    <div className="space-y-6">
      {canonical && (
        <div className="flex items-start gap-2 border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
          <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
          <span>Link values for epoch {canonical.epoch}.</span>
        </div>
      )}

      <div className="border border-border bg-surface p-4">
        <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono mb-2">
          Contributor
        </label>
        <select
          value={contributor}
          onChange={(e) => setContributor(e.target.value || null)}
          className="w-full sm:w-auto min-w-[280px] border border-border bg-background px-3 py-2 text-sm font-mono"
        >
          <option value="">Choose a contributor…</option>
          {contributors.map((c) => (
            <option key={c.code} value={c.code}>
              {getContributorDisplayName(c.code)} · {c.linkCount} links
            </option>
          ))}
        </select>
      </div>

      {!contributor && (
        <EmptyState
          title="Pick a contributor"
          message="Choose an operator above to see the value of each of their links."
        />
      )}

      {contributor && overLinkCap && selected && (
        <EmptyState
          title="Per-link breakdown unavailable"
          message={`A per-link breakdown isn't available for ${getContributorDisplayName(
            contributor,
          )} — it connects to too many links to value individually.`}
        />
      )}

      {contributor && !overLinkCap && canonicalErr && (
        <ErrorState
          title="Couldn't load link values"
          message={
            canonicalTerminal
              ? canonicalErr
              : `${canonicalErr}. Try again shortly.`
          }
        />
      )}

      {contributor && canonicalLoading && (
        <div className="border border-border bg-surface p-6 flex items-center gap-3 text-sm text-cream-60">
          <Loader2 className="size-4 animate-spin shrink-0" />
          <span>
            {typeof progress === "number" && progress > 0 ? (
              <>Calculating link values — {Math.round(progress)}%</>
            ) : (
              <>
                Calculating link values… This is usually quick, but can take a
                few minutes for operators with many links.
              </>
            )}
          </span>
        </div>
      )}

      {contributor && canonical && metaRows.length === 0 && (
        <EmptyState
          title="No links for this contributor"
          message="They have devices but no active links in the live topology."
        />
      )}

      {contributor && canonical && rows.length > 0 && (
        <>
          <div className="grid grid-cols-3 gap-px border border-border bg-border">
            <Stat label="Total links" value={rows.length} />
            <Stat
              label="High value"
              value={rows.filter((r) => r.tier === "High").length}
              tone="ok"
            />
            {unvalued > 0 ? (
              <Stat label="No value" value={unvalued} tone="warn" />
            ) : (
              <Stat
                label="Low value"
                value={rows.filter((r) => r.tier === "Low").length}
                tone="warn"
              />
            )}
          </div>

          <div className="border border-border bg-surface">
            <div className="border-b border-border px-4 py-2.5 flex items-center gap-2">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: getContributorColor(contributor) }}
              />
              <span className="text-sm font-medium">
                {getContributorDisplayName(contributor)}
              </span>
              <span className="text-xs font-mono text-cream-30">
                · per-link value share
              </span>
            </div>

            <div className="divide-y divide-border">
              {rows.map((r) => (
                <div
                  key={r.linkPk}
                  className="px-4 py-3 grid grid-cols-12 gap-3 items-center text-sm"
                >
                  <div className="col-span-12 sm:col-span-3 min-w-0">
                    <Link
                      href={`/links/${r.linkPk}`}
                      className="font-mono text-xs text-cream-60 hover:text-foreground truncate block"
                    >
                      {r.code}
                    </Link>
                    <div className="text-xs text-cream-30 font-mono">
                      {r.sideAMetro.toUpperCase()} →{" "}
                      {r.sideZMetro.toUpperCase()}
                    </div>
                  </div>
                  <div className="col-span-8 sm:col-span-5">
                    <div className="h-1.5 bg-cream-8 overflow-hidden">
                      <div
                        className="h-full"
                        style={{
                          width: `${Math.min((r.percent ?? 0) * 1.5, 100)}%`,
                          backgroundColor: getContributorColor(contributor),
                        }}
                      />
                    </div>
                  </div>
                  <div className="col-span-4 sm:col-span-1 text-right tabular-nums font-mono">
                    {r.percent !== null ? `${r.percent.toFixed(1)}%` : "—"}
                  </div>
                  <div className="col-span-6 sm:col-span-2 text-right tabular-nums font-mono text-cream-60 text-xs">
                    {fmtBps(r.bandwidthBps)}
                    {r.latencyUs > 0 &&
                      ` · ${(r.latencyUs / 1000).toFixed(1)}ms`}
                  </div>
                  <div className="col-span-6 sm:col-span-1 text-right">
                    {r.tier ? (
                      <Tier tier={r.tier} />
                    ) : (
                      <span
                        className="text-xs font-mono uppercase tracking-[0.14em] px-2 py-0.5 border bg-cream-8 text-cream-40 border-cream-15"
                        title="No value available for this link in this epoch."
                      >
                        n/a
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-border bg-surface p-4 flex items-start gap-2 text-xs text-cream-40">
            <Info className="size-3.5 shrink-0 mt-0.5" />
            <span>
              Share is each link&apos;s portion of this operator&apos;s total
              contribution for the epoch. Tiers: High ≥ 25%, Medium ≥ 8%.
              Links marked &quot;n/a&quot; have no value this epoch. See{" "}
              <Link
                href="/methodology"
                className="underline decoration-dotted hover:text-foreground"
              >
                Methodology
              </Link>{" "}
              for how values are computed.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-mono tabular-nums ${
          tone === "ok"
            ? "text-emerald-300"
            : tone === "warn"
            ? "text-amber-300"
            : ""
        }`}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function Tier({ tier }: { tier: "High" | "Medium" | "Low" }) {
  const cls =
    tier === "High"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
      : tier === "Medium"
      ? "bg-amber-500/10 text-amber-300 border-amber-500/20"
      : "bg-cream-8 text-cream-40 border-cream-15";
  return (
    <span
      className={`text-xs font-mono uppercase tracking-[0.14em] px-2 py-0.5 border ${cls}`}
    >
      {tier}
    </span>
  );
}

export default function LinkValuePage() {
  return (
    <>
      <PageHeader
        title="Link Rewards"
        description="How much each of an operator's existing links contributes to their reward this epoch."
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
        <Suspense fallback={<LoadingState label="Loading" />}>
          <Inner />
        </Suspense>
      </div>
    </>
  );
}
