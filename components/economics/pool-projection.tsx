"use client";

import { useState } from "react";
import { usePoolProjection } from "@/lib/hooks/use-live";
import { Sparkline } from "@/components/ui/sparkline";
import { LoadingState, ErrorState } from "@/components/ui/states";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";
import { Download } from "lucide-react";

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
function fmtUsd(n: number, digits = 0): string {
  return "$" + fmtNum(n, digits);
}

const HORIZON_OPTIONS = [12, 30, 60, 144] as const;

/**
 * Forward-looking pool projection. Uses the average distributed 2Z per
 * epoch with a debt-ratio-derived growth multiplier as a sanity-bounded
 * forecast. Replaced with a per-epoch fitted curve once DZ ships per-epoch
 * payouts (Q9).
 */
export function PoolProjection() {
  const [horizon, setHorizon] = useState<number>(30);
  const { data, isLoading, error, mutate } = usePoolProjection(horizon);

  if (error) {
    return (
      <ErrorState
        title="Couldn't load projection"
        message={(error as Error).message}
        onRetry={() => mutate()}
      />
    );
  }
  if (isLoading || !data) {
    return <LoadingState label="Computing forward projection" />;
  }

  const series2Z = data.projectedEpochs.map((p) => p.projected2Z);
  const totalProjected = data.projectedEpochs.reduce(
    (s, p) => s + p.projected2Z,
    0,
  );
  const totalProjectedUsd = data.projectedEpochs.reduce(
    (s, p) => s + p.projectedUsd,
    0,
  );

  const growthPct = data.growthRate * 100;

  const exportCsv = () => {
    downloadCsv(
      `dz-pool-projection-h${horizon}-${new Date().toISOString().slice(0, 10)}.csv`,
      rowsToCsv(
        ["Epoch offset", "Projected 2Z", "Projected USD", "Cumulative 2Z", "Cumulative USD"],
        data.projectedEpochs.map((p) => [
          p.epochOffset,
          p.projected2Z.toFixed(2),
          p.projectedUsd.toFixed(2),
          p.cumulative2Z.toFixed(2),
          p.cumulativeUsd.toFixed(2),
        ]),
      ),
    );
  };

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Pool projection · next {horizon} epochs
        </span>
        <div className="flex items-center gap-3 text-xs font-mono">
          <div className="flex items-center gap-1">
            {HORIZON_OPTIONS.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setHorizon(h)}
                className={`px-2 py-0.5 transition-colors ${
                  horizon === h
                    ? "text-foreground bg-surface-2"
                    : "text-cream-30 hover:text-foreground"
                }`}
              >
                {h}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Download className="size-3" />
            CSV
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
          <Stat
            label="Avg 2Z / epoch"
            value={fmtNum(data.historicalAvg2ZPerEpoch, 0)}
            sub={fmtUsd(data.historicalAvgUsdPerEpoch)}
          />
          <Stat
            label="Growth / epoch"
            value={`${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(2)}%`}
            sub={`debt ratio ${data.debtRatio.toFixed(2)}`}
            tone={growthPct > 0 ? "ok" : growthPct < 0 ? "warn" : undefined}
          />
          <Stat
            label={`Σ ${horizon} epochs`}
            value={fmtNum(totalProjected, 0)}
            sub={fmtUsd(totalProjectedUsd)}
          />
          <Stat
            label="Final epoch"
            value={fmtNum(data.projectedEpochs[data.projectedEpochs.length - 1]?.projected2Z ?? 0, 0)}
            sub={`offset +${horizon}`}
          />
        </div>

        <div>
          <Sparkline
            data={series2Z}
            width={1000}
            height={80}
            className="w-full text-cream-60"
          />
          <div className="flex justify-between text-xs text-cream-30 font-mono mt-1">
            <span>now (epoch {data.latestDistributedEpoch})</span>
            <span>+{horizon} epochs</span>
          </div>
        </div>

        <p className="text-xs text-cream-30 font-mono leading-relaxed">
          {data.methodology}
        </p>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
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
      <div className={`mt-1 text-lg font-mono tabular-nums ${cls}`}>{value}</div>
      {sub && (
        <div className="text-xs text-cream-30 font-mono mt-0.5">{sub}</div>
      )}
    </div>
  );
}
