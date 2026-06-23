"use client";

import useSWR from "swr";
import { Plus, Minus, ArrowRight, RefreshCw } from "lucide-react";

interface LinkRef {
  pubkey: string;
  contributorCode: string;
  sideACode: string;
  sideZCode: string;
  bandwidthGbps: number;
  linkType: string;
}

interface LinkChange {
  pubkey: string;
  sideACode: string;
  sideZCode: string;
  before: { bandwidthGbps: number; linkType: string };
  after: { bandwidthGbps: number; linkType: string };
}

interface ContributorDiff {
  code: string;
  name: string;
  from: number;
  to: number;
  summary: {
    linksAdded: number;
    linksRemoved: number;
    linksChanged: number;
    bandwidthGbpsBefore: number;
    bandwidthGbpsAfter: number;
    bandwidthGbpsDelta: number;
  };
  footprint: {
    before: { linkCount: number; deviceCount: number; metroCount: number };
    after: { linkCount: number; deviceCount: number; metroCount: number };
    firstSeen: boolean;
    leftNetwork: boolean;
  };
  added: LinkRef[];
  removed: LinkRef[];
  changed: LinkChange[];
}

interface EpochsData {
  latest: number;
  earliest: number;
  available: number[];
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
};

export function ContributorChangelog({
  code,
  windowSize = 7,
}: {
  code: string;
  windowSize?: number;
}) {
  const { data: epochs } = useSWR<EpochsData>("/api/epochs", fetcher);
  const latest = epochs?.latest;
  const from =
    latest && epochs?.available
      ? epochs.available.find((e) => e <= latest - windowSize) ??
        epochs.available[epochs.available.length - 1]
      : null;

  const url =
    latest && from && from !== latest
      ? `/api/diff/contributor/${encodeURIComponent(code)}?from=${from}&to=${latest}`
      : null;

  const { data: diff, error } = useSWR<ContributorDiff>(url, fetcher);

  if (!latest || !from) return null;

  if (error) {
    return (
      <div className="border border-border bg-surface p-4 text-xs text-muted-foreground font-mono">
        Couldn&apos;t load changelog: {(error as Error).message}
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="border border-border bg-surface p-4 text-xs text-muted-foreground font-mono">
        Loading changelog…
      </div>
    );
  }

  const noChanges =
    diff.summary.linksAdded === 0 &&
    diff.summary.linksRemoved === 0 &&
    diff.summary.linksChanged === 0;

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Recent changes · DZ epochs {diff.from} → {diff.to}
        </span>
        {!noChanges && (
          <span className="text-xs font-mono text-muted-foreground tabular-nums">
            {diff.summary.bandwidthGbpsDelta > 0 ? "+" : ""}
            {diff.summary.bandwidthGbpsDelta.toFixed(1)} Gbps
          </span>
        )}
      </div>

      {noChanges ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground font-mono">
          No footprint changes in the last {windowSize} epochs.
        </div>
      ) : (
        <div className="divide-y divide-border text-sm">
          {diff.added.map((l) => (
            <Row
              key={`add-${l.pubkey}`}
              icon={<Plus className="size-3.5 text-emerald-400" />}
              tone="emerald"
              left={`${l.sideACode} → ${l.sideZCode}`}
              right={`${l.bandwidthGbps}G ${l.linkType}`}
              label="Added"
            />
          ))}
          {diff.changed.map((c) => (
            <Row
              key={`chg-${c.pubkey}`}
              icon={<RefreshCw className="size-3.5 text-amber-400" />}
              tone="amber"
              left={`${c.sideACode} → ${c.sideZCode}`}
              right={
                <span className="font-mono">
                  {c.before.bandwidthGbps}G{" "}
                  <ArrowRight className="size-3 inline text-cream-30" />{" "}
                  {c.after.bandwidthGbps}G
                </span>
              }
              label="Changed"
            />
          ))}
          {diff.removed.map((l) => (
            <Row
              key={`rm-${l.pubkey}`}
              icon={<Minus className="size-3.5 text-red-400" />}
              tone="red"
              left={`${l.sideACode} → ${l.sideZCode}`}
              right={`${l.bandwidthGbps}G ${l.linkType}`}
              label="Removed"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  icon,
  tone,
  left,
  right,
  label,
}: {
  icon: React.ReactNode;
  tone: "emerald" | "amber" | "red";
  left: React.ReactNode;
  right: React.ReactNode;
  label: string;
}) {
  const labelTone =
    tone === "emerald"
      ? "text-emerald-400"
      : tone === "amber"
        ? "text-amber-400"
        : "text-red-400";
  return (
    <div className="px-4 py-2.5 flex items-center gap-3 text-xs">
      <span className="shrink-0">{icon}</span>
      <span
        className={`${labelTone} uppercase tracking-[0.12em] font-mono w-20 shrink-0`}
      >
        {label}
      </span>
      <span className="font-mono text-cream-60 tabular-nums uppercase">
        {left}
      </span>
      <span className="ml-auto text-cream-40 font-mono">{right}</span>
    </div>
  );
}
