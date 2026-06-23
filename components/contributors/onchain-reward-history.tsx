"use client";

import useSWR from "swr";
import { useMemo } from "react";
import { Sparkline } from "@/components/ui/sparkline";
import { Info, Database } from "lucide-react";

interface OnchainEpoch {
  epoch: number;
  unitShare: number;
  share: number;
  isBlocked: boolean;
  totalUnitSharesStored: number;
  recordAddress: string;
}

interface OnchainResponse {
  code: string | null;
  ownerKey: string;
  epochs: OnchainEpoch[];
  epochCount: number;
  source: "onchain";
  fetchedAt: string;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return null; // contributor not on-chain yet
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
};

/**
 * Per-epoch on-chain reward history for a contributor. Pulls from the
 * `/api/onchain/contributor-rewards?code=…` route which reads the
 * canonical `ShapleyOutputStorage` records from the DZ ledger.
 *
 * Renders nothing if the contributor has no on-chain history yet.
 */
export function OnchainRewardHistory({
  contributorCode,
}: {
  contributorCode: string;
}) {
  const { data, error, isLoading } = useSWR<OnchainResponse | null>(
    `/api/onchain/contributor-rewards?code=${encodeURIComponent(contributorCode)}`,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5 * 60_000,
    },
  );

  const series = useMemo(
    () => (data?.epochs ?? []).map((e) => e.share * 100),
    [data],
  );

  const stats = useMemo(() => {
    if (!data || data.epochs.length === 0) return null;
    const shares = data.epochs.map((e) => e.share);
    const total = shares.reduce((s, x) => s + x, 0);
    const avg = total / shares.length;
    const min = Math.min(...shares);
    const max = Math.max(...shares);
    const latest = data.epochs[data.epochs.length - 1];
    const earliest = data.epochs[0];
    return { avg, min, max, latest, earliest };
  }, [data]);

  if (isLoading) {
    return (
      <div className="border border-border bg-surface">
        <SectionHeader />
        <div className="px-4 py-6 text-xs text-cream-30 font-mono">
          Loading on-chain history…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-border bg-surface">
        <SectionHeader />
        <div className="px-4 py-3 text-xs text-amber-300/80 font-mono">
          Couldn&apos;t reach DZ ledger right now. Site falls back to the
          off-chain estimate below.
        </div>
      </div>
    );
  }

  if (!data || data.epochs.length === 0) {
    return null;
  }

  return (
    <div className="border border-border bg-surface">
      <SectionHeader />
      <div className="px-4 py-3 grid gap-3 sm:grid-cols-4">
        <Stat
          label="Latest epoch"
          value={`#${stats!.latest.epoch}`}
          sub={`${(stats!.latest.share * 100).toFixed(4)}%`}
        />
        <Stat
          label="Avg share"
          value={`${(stats!.avg * 100).toFixed(4)}%`}
          sub={`across ${data.epochCount} epochs`}
        />
        <Stat
          label="Range"
          value={`${(stats!.min * 100).toFixed(2)}–${(stats!.max * 100).toFixed(2)}%`}
          sub={`epochs ${stats!.earliest.epoch}–${stats!.latest.epoch}`}
        />
        <Stat
          label="On-chain owner"
          value={shorten(data.ownerKey)}
          sub="DZ ledger pubkey"
        />
      </div>

      <div className="px-4 pb-4">
        <Sparkline
          data={series}
          width={1000}
          height={80}
          className="w-full text-primary"
        />
        <div className="mt-2 text-xs font-mono text-cream-30 flex items-center gap-1.5">
          <Info className="size-3" />
          Share of contributor pool per epoch, read directly from on-chain{" "}
          <code className="text-cream-60">ShapleyOutputStorage</code> records
          on the DZ ledger.
        </div>
      </div>

      <details className="border-t border-border">
        <summary className="px-4 py-2 text-xs font-mono uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground cursor-pointer">
          Show per-epoch table ({data.epochCount} rows)
        </summary>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                <th className="px-3 py-2 text-left font-normal">Epoch</th>
                <th className="px-3 py-2 text-right font-normal">Unit share</th>
                <th className="px-3 py-2 text-right font-normal">% of pool</th>
                <th className="px-3 py-2 text-left font-normal hidden sm:table-cell">
                  Record
                </th>
              </tr>
            </thead>
            <tbody>
              {[...data.epochs].reverse().map((ep) => (
                <tr key={ep.epoch} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-1.5 font-mono tabular-nums">
                    {ep.epoch}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {ep.unitShare.toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {(ep.share * 100).toFixed(4)}%
                    {ep.isBlocked ? (
                      <span className="ml-1 text-red-400">(blocked)</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-cream-30 hidden sm:table-cell">
                    {shorten(ep.recordAddress)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function SectionHeader() {
  return (
    <div className="border-b border-border px-4 py-2.5 flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
      <Database className="size-3.5" />
      On-chain reward share · DZ ledger
      <span className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal text-xs text-emerald-300/80">
        <span className="size-1.5 rounded-full bg-emerald-400" />
        canonical
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className="text-sm font-mono tabular-nums text-foreground">
        {value}
      </div>
      {sub ? (
        <div className="text-xs text-cream-30 font-mono">{sub}</div>
      ) : null}
    </div>
  );
}

function shorten(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
