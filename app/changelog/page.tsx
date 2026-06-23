"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { PageHeader } from "@/components/ui/page-header";
import { useEpochs } from "@/lib/hooks/use-epochs";
import {
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import { LoadingState, ErrorState, EmptyState } from "@/components/ui/states";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";
import {
  ArrowRight,
  Plus,
  Minus,
  Edit3,
  Download,
  ExternalLink,
} from "lucide-react";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

interface DiffLink {
  pubkey: string;
  contributorCode: string;
  sideACode: string;
  sideZCode: string;
  bandwidthGbps: number;
  linkType: string;
  /** Earliest intermediate epoch where the link was first observed in
   *  its new state (added/removed). Server-side attribution; falls
   *  back to `to` if no intermediates were walked. */
  firstObservedEpoch?: number;
}
interface DiffChange {
  pubkey: string;
  contributorCode: string;
  field: string;
  before: unknown;
  after: unknown;
  firstObservedEpoch?: number;
}
interface DiffContributor {
  code: string;
  beforeLinkCount: number;
  afterLinkCount: number;
  beforeDeviceCount: number;
  afterDeviceCount: number;
  beforeMetroCount: number;
  afterMetroCount: number;
  linksAdded: number;
  linksRemoved: number;
  linksChanged: number;
  bandwidthGbpsBefore: number;
  bandwidthGbpsAfter: number;
  bandwidthGbpsDelta: number;
  firstSeen: boolean;
  leftNetwork: boolean;
}
interface DiffResponse {
  from: number;
  to: number;
  summary: {
    linksAdded: number;
    linksRemoved: number;
    linksChanged: number;
    contributorsAffected: number;
  };
  contributors: DiffContributor[];
  added: DiffLink[];
  removed: DiffLink[];
  changed: DiffChange[];
  fetchedAt: string;
}

export default function ChangelogPage() {
  const { data: epochsData, isLoading: epLoading } = useEpochs();
  const sorted = useMemo(
    () => (epochsData?.available ?? []).slice().sort((a, b) => b - a),
    [epochsData],
  );

  // User-selected overrides. `null` means "use the auto-default below".
  const [fromOverride, setFromOverride] = useState<number | null>(null);
  const [toOverride, setToOverride] = useState<number | null>(null);

  // Derive the effective from/to from the override + the loaded epoch
  // list. Default = "latest vs previous" whenever no explicit selection
  // exists. This replaces a set-in-effect pattern that defaulted on load.
  const from =
    fromOverride ?? (sorted.length >= 2 ? sorted[1] : null);
  const to = toOverride ?? (sorted.length >= 1 ? sorted[0] : null);

  // Old setter names preserved so the rest of the page reads unchanged.
  const setFrom = setFromOverride;
  const setTo = setToOverride;

  const url =
    from !== null && to !== null && from !== to
      ? `/api/diff?from=${from}&to=${to}`
      : null;
  const { data, isLoading, error, mutate } = useSWR<DiffResponse>(
    url,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 5 * 60_000 },
  );

  return (
    <>
      <PageHeader
        title="Changelog"
        description="What changed between any two snapshots — links added, removed, bandwidth changes, and per-contributor footprint deltas."
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6 space-y-6">
        {/* Epoch selectors */}
        <div className="border border-border bg-surface p-4 flex flex-wrap items-end gap-3">
          <EpochSelect
            label="From"
            value={from}
            onChange={setFrom}
            options={sorted}
            disabledValue={to}
          />
          <ArrowRight className="size-4 text-cream-30 shrink-0 mb-2" />
          <EpochSelect
            label="To"
            value={to}
            onChange={setTo}
            options={sorted}
            disabledValue={from}
          />
          <button
            type="button"
            onClick={() => {
              // Clear overrides → derived defaults produce "latest vs previous".
              setFromOverride(null);
              setToOverride(null);
            }}
            className="text-xs font-mono uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground transition-colors ml-auto"
          >
            Latest vs previous
          </button>
        </div>

        {epLoading || (url && isLoading && !data) ? (
          <LoadingState label="Computing diff" />
        ) : error ? (
          <ErrorState
            title="Couldn't load diff"
            message={(error as Error).message}
            onRetry={() => mutate()}
          />
        ) : !data ? (
          <EmptyState
            title="Pick two epochs"
            message="Select different from/to epochs above to compute a diff."
          />
        ) : (
          <DiffView data={data} />
        )}
      </div>
    </>
  );
}

function EpochSelect({
  label,
  value,
  onChange,
  options,
  disabledValue,
}: {
  label: string;
  value: number | null;
  onChange: (v: number) => void;
  options: number[];
  disabledValue: number | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground font-mono">
        {label}
      </span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="border border-border bg-background px-3 py-2 text-sm font-mono"
      >
        {options.map((ep) => (
          <option key={ep} value={ep} disabled={ep === disabledValue}>
            Epoch {ep}
          </option>
        ))}
      </select>
    </div>
  );
}

function DiffView({ data }: { data: DiffResponse }) {
  const exportCsv = () => {
    const headers = [
      "Contributor",
      "Display Name",
      "Δ Links",
      "Links Added",
      "Links Removed",
      "Links Changed",
      "Δ Bandwidth (Gbps)",
      "First seen",
      "Left network",
    ];
    const rows = data.contributors.map((c) => [
      c.code,
      getContributorDisplayName(c.code),
      c.afterLinkCount - c.beforeLinkCount,
      c.linksAdded,
      c.linksRemoved,
      c.linksChanged,
      c.bandwidthGbpsDelta,
      c.firstSeen ? "yes" : "",
      c.leftNetwork ? "yes" : "",
    ]);
    downloadCsv(
      `dz-changelog-${data.from}-${data.to}.csv`,
      rowsToCsv(headers, rows),
    );
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px border border-border bg-border">
        <SummaryStat label="Links added" value={data.summary.linksAdded} tone="ok" />
        <SummaryStat label="Links removed" value={data.summary.linksRemoved} tone="warn" />
        <SummaryStat label="Links changed" value={data.summary.linksChanged} />
        <SummaryStat
          label="Contributors affected"
          value={data.summary.contributorsAffected}
        />
      </div>

      {/* Per-contributor */}
      <div className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5 flex items-center justify-between">
          <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
            Per-contributor changes · epoch {data.from} → {data.to}
          </span>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            <Download className="size-3" />
            CSV
          </button>
        </div>
        {data.contributors.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No contributor-level changes between these epochs.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {data.contributors.map((c) => {
              const linkDelta = c.afterLinkCount - c.beforeLinkCount;
              return (
                <Link
                  key={c.code}
                  href={`/contributors/${c.code}`}
                  className="px-4 py-3 grid grid-cols-12 gap-3 items-center text-sm hover:bg-surface-2/40 transition-colors"
                >
                  <div className="col-span-12 sm:col-span-3 flex items-center gap-2 min-w-0">
                    <span
                      className="size-2 rounded-full shrink-0"
                      style={{ backgroundColor: getContributorColor(c.code) }}
                    />
                    <span className="font-medium truncate">
                      {getContributorDisplayName(c.code)}
                    </span>
                    {c.firstSeen && (
                      <span className="text-xs font-mono text-emerald-400 shrink-0">
                        NEW
                      </span>
                    )}
                    {c.leftNetwork && (
                      <span className="text-xs font-mono text-red-400 shrink-0">
                        LEFT
                      </span>
                    )}
                  </div>
                  <div className="col-span-6 sm:col-span-2 tabular-nums font-mono text-xs">
                    <span className="text-cream-30">links</span>{" "}
                    <span>
                      {c.beforeLinkCount} → {c.afterLinkCount}
                    </span>{" "}
                    <span
                      className={
                        linkDelta > 0
                          ? "text-emerald-400"
                          : linkDelta < 0
                          ? "text-red-400"
                          : "text-cream-30"
                      }
                    >
                      ({linkDelta >= 0 ? "+" : ""}
                      {linkDelta})
                    </span>
                  </div>
                  <div className="col-span-6 sm:col-span-3 tabular-nums font-mono text-xs">
                    <span className="text-cream-30">bw</span>{" "}
                    <span>
                      {c.bandwidthGbpsBefore.toFixed(0)} →{" "}
                      {c.bandwidthGbpsAfter.toFixed(0)} G
                    </span>{" "}
                    <span
                      className={
                        c.bandwidthGbpsDelta > 0
                          ? "text-emerald-400"
                          : c.bandwidthGbpsDelta < 0
                          ? "text-red-400"
                          : "text-cream-30"
                      }
                    >
                      ({c.bandwidthGbpsDelta >= 0 ? "+" : ""}
                      {c.bandwidthGbpsDelta.toFixed(0)})
                    </span>
                  </div>
                  <div className="col-span-12 sm:col-span-3 text-xs font-mono text-cream-30">
                    {c.linksAdded > 0 && (
                      <span className="mr-2 text-emerald-400">
                        +{c.linksAdded}
                      </span>
                    )}
                    {c.linksRemoved > 0 && (
                      <span className="mr-2 text-red-400">
                        −{c.linksRemoved}
                      </span>
                    )}
                    {c.linksChanged > 0 && (
                      <span className="mr-2 text-amber-400">
                        ~{c.linksChanged}
                      </span>
                    )}
                  </div>
                  <div className="col-span-12 sm:col-span-1 flex items-center justify-end">
                    <ExternalLink className="size-3 text-cream-30" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Added links */}
      {data.added.length > 0 && (
        <ChangeList
          title="Links added"
          icon={<Plus className="size-3 text-emerald-400" />}
          windowFrom={data.from}
          windowTo={data.to}
          items={data.added.map((l) => ({
            key: l.pubkey,
            contributor: l.contributorCode,
            text: `${l.sideACode} ↔ ${l.sideZCode}`,
            meta: `${l.bandwidthGbps}G · ${l.linkType}`,
            epoch: l.firstObservedEpoch ?? data.to,
          }))}
        />
      )}

      {/* Removed links */}
      {data.removed.length > 0 && (
        <ChangeList
          title="Links removed"
          icon={<Minus className="size-3 text-red-400" />}
          windowFrom={data.from}
          windowTo={data.to}
          items={data.removed.map((l) => ({
            key: l.pubkey,
            contributor: l.contributorCode,
            text: `${l.sideACode} ↔ ${l.sideZCode}`,
            meta: `${l.bandwidthGbps}G · ${l.linkType}`,
            epoch: l.firstObservedEpoch ?? data.to,
          }))}
        />
      )}

      {/* Changed links */}
      {data.changed.length > 0 && (
        <ChangeList
          title="Links modified"
          icon={<Edit3 className="size-3 text-amber-400" />}
          windowFrom={data.from}
          windowTo={data.to}
          items={data.changed.map((c, i) => ({
            key: `${c.pubkey}-${i}`,
            contributor: c.contributorCode,
            text: c.field,
            meta: `${String(c.before)} → ${String(c.after)}`,
            epoch: c.firstObservedEpoch ?? data.to,
          }))}
        />
      )}
    </div>
  );
}

function ChangeList({
  title,
  icon,
  windowFrom,
  windowTo,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  windowFrom: number;
  windowTo: number;
  items: Array<{
    key: string;
    contributor: string;
    text: string;
    meta: string;
    epoch: number;
  }>;
}) {
  // Summarize the spread of attributed epochs across the items. If
  // every change in this list landed in a single epoch we say so;
  // otherwise we report the min..max range so the header doesn't
  // overclaim precision.
  const epochs = items.map((i) => i.epoch);
  const epochMin = Math.min(...epochs);
  const epochMax = Math.max(...epochs);
  const headerLabel =
    items.length === 0
      ? ""
      : epochMin === epochMax
        ? `landed in epoch ${epochMin}`
        : `landed across epochs ${epochMin}–${epochMax}`;

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center gap-2">
        {icon}
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          {title} ({items.length})
        </span>
        <span className="ml-auto text-xs font-mono text-cream-30 tabular-nums">
          {headerLabel}
        </span>
      </div>
      <div className="divide-y divide-border max-h-96 overflow-y-auto">
        {items.map((item) => (
          <div
            key={item.key}
            className="px-4 py-2 flex items-center justify-between gap-3 text-xs"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="size-1.5 rounded-full shrink-0"
                style={{
                  backgroundColor: getContributorColor(item.contributor),
                }}
              />
              <span className="font-medium truncate">
                {getContributorDisplayName(item.contributor)}
              </span>
              <span className="text-cream-30 font-mono truncate">{item.text}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-cream-40 font-mono">{item.meta}</span>
              <span
                className="font-mono text-xs text-cream-30 tabular-nums px-1.5 py-0.5 border border-border bg-surface-2/40"
                title={`First observed in DZ epoch ${item.epoch} (comparison window: ${windowFrom}→${windowTo})`}
              >
                ep {item.epoch}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn";
}) {
  const cls =
    tone === "ok"
      ? "text-emerald-300"
      : tone === "warn"
      ? "text-amber-300"
      : "";
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-mono tabular-nums ${cls}`}>
        {value}
      </div>
    </div>
  );
}
