"use client";

import { useMemo } from "react";
import type { FeeHistory } from "@/lib/types/fees";
import type { ParsedSnapshot } from "@/lib/types/contributor";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatSol } from "@/lib/utils/format";
import { computeFeeTrend } from "@/lib/utils/reward-estimator";

interface NetworkEconomicsProps {
  feeHistory: FeeHistory | undefined;
  snapshot: ParsedSnapshot;
}

export function NetworkEconomics({ feeHistory, snapshot }: NetworkEconomicsProps) {
  const feeTrend = useMemo(
    () => (feeHistory ? computeFeeTrend(feeHistory) : null),
    [feeHistory]
  );

  if (!feeHistory || feeHistory.epochs.length === 0) {
    return (
      <Card className="bg-cream-5 border-cream-8">
        <CardContent className="py-8 text-center text-sm text-cream-40">
          Fee history data is currently unavailable. Check back later.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Key metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard
          label="Total fees collected"
          value={formatSol(feeHistory.totalFeeLamports, 0)}
          note={`Over ${feeHistory.epochs.length} epochs`}
          unit="SOL"
        />
        <MetricCard
          label="Average per epoch"
          value={formatSol(feeHistory.averageFeeLamports, 2)}
          note="~2.5 days per epoch"
          unit="SOL"
        />
        <MetricCard
          label="Fee split"
          value="45 / 45 / 10"
          note="Contributors / Validators / Burn"
        />
        <MetricCard
          label="Fee trend"
          value={
            feeTrend?.direction === "growing"
              ? "Growing"
              : feeTrend?.direction === "declining"
              ? "Declining"
              : "Stable"
          }
          valueClassName={
            feeTrend?.direction === "growing"
              ? "text-green"
              : feeTrend?.direction === "declining"
              ? "text-red"
              : "text-cream-30"
          }
        />
      </div>

      {/* Fee history chart */}
      <Card className="bg-cream-5 border-cream-8">
        <CardHeader>
          <CardTitle className="font-display text-sm tracking-wide text-cream">
            Fee History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-[1px] sm:gap-[2px] h-24 sm:h-32">
            {(() => {
              const recent = feeHistory.epochs.slice(-40);
              const maxFee = recent.length > 0 ? Math.max(...recent.map((ep) => ep.totalFeeLamports)) : 0;
              return recent.map((e) => {
              const height =
                maxFee > 0 ? (e.totalFeeLamports / maxFee) * 100 : 0;
              return (
                <div
                  key={e.solanaEpoch}
                  className="flex-1 rounded-t bg-cream-15 hover:bg-cream-30 transition-colors"
                  style={{ height: `${height}%` }}
                  title={`Epoch ${e.solanaEpoch}: ${formatSol(e.totalFeeLamports, 2)} SOL`}
                />
              );
            })})()}
          </div>
          <div className="flex justify-between text-xs text-cream-20 mt-2">
            <span>
              Epoch {feeHistory.epochs.slice(-40)[0]?.solanaEpoch}
            </span>
            <span>
              Epoch{" "}
              {feeHistory.epochs[feeHistory.epochs.length - 1]?.solanaEpoch}
            </span>
          </div>
          <p className="text-xs text-cream-20 mt-3">
            Fees recorded from Solana epoch {feeHistory.earliestEpoch}–{feeHistory.latestEpoch}
            {feeHistory.epochs.length > 0 ? ` (${feeHistory.epochs.length} epochs)` : ""}.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  unit,
  valueClassName,
}: {
  label: string;
  value: string;
  note?: string;
  unit?: string;
  valueClassName?: string;
}) {
  return (
    <Card className="bg-cream-5 border-cream-8">
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-cream-40 mb-1">{label}</p>
        <div className="flex items-baseline gap-1">
          <p className={`text-lg sm:text-xl font-display ${valueClassName ?? "text-cream"}`}>{value}</p>
          {unit && <p className="text-xs text-cream-40">{unit}</p>}
        </div>
        {note && <p className="text-xs text-cream-20 mt-1">{note}</p>}
      </CardContent>
    </Card>
  );
}
