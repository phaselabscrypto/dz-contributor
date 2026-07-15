"use client";

import { useMemo } from "react";
import {
  useEconomicHub,
  useBaselineShapley,
} from "@/lib/hooks/use-live";
import { ehNameToCode } from "@/lib/constants/config";
import { ArrowUpRight, ArrowDownRight, Minus, Info } from "lucide-react";
import { LoadingState, EmptyState } from "@/components/ui/states";

interface Props {
  contributorCode: string;
}

/**
 * Three-way reward reconciliation:
 *   1) all-time earned share (economic-hub, payout-weighted)
 *   2) current Shapley share (live baseline against today's topology)
 *   3) delta + plain-English explanation
 *
 * Helps an operator answer "is my historical earning aligned with my
 * current contribution to the network?"
 */
export function RewardReconciliation({ contributorCode }: Props) {
  const { data: hub, isLoading: hubLoading } = useEconomicHub();
  const { data: baseline, isLoading: baselineLoading } = useBaselineShapley();

  const ehEntry = useMemo(() => {
    if (!hub) return undefined;
    return hub.contributors.find(
      (c) => ehNameToCode(c.name) === contributorCode,
    );
  }, [hub, contributorCode]);

  const allTimePct = ehEntry?.rewardPercentage ?? 0;
  const livePct = baseline?.values?.[contributorCode]?.share
    ? baseline.values[contributorCode].share * 100
    : 0;

  if (hubLoading || baselineLoading) {
    return (
      <div className="border border-border bg-surface p-6">
        <LoadingState label="Reconciling reward share" />
      </div>
    );
  }

  if (!hub || !baseline) {
    return null;
  }

  if (allTimePct === 0 && livePct === 0) {
    return (
      <EmptyState
        title="No reward share to reconcile"
        message="This contributor has no on-chain payouts yet and no Shapley contribution against the current network."
      />
    );
  }

  const delta = livePct - allTimePct;
  const direction =
    delta > 0.1 ? "up" : delta < -0.1 ? "down" : "flat";

  const headlineCopy = (() => {
    if (allTimePct === 0) {
      return "New on the network — no historical payouts yet, but they're already contributing measurable Shapley value.";
    }
    if (livePct === 0) {
      return "Currently contributes no Shapley value against the live network. Their historical earnings come from prior coalitions that no longer exist as-is.";
    }
    if (direction === "up") {
      return "Currently contributing more Shapley value than their all-time payout share. Future epochs should track higher.";
    }
    if (direction === "down") {
      return "Currently contributing less Shapley value than their all-time payout share. Their historical earnings reflect a stronger past footprint.";
    }
    return "Current contribution closely tracks their all-time payout share.";
  })();

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Reward share reconciliation
        </span>
        <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
          Live vs all-time
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border">
        <Cell
          label="All-time payout"
          value={allTimePct > 0 ? `${allTimePct.toFixed(2)}%` : "—"}
          sub={`${hub.epochs.length} distributed epochs`}
        />
        <Cell
          label="Latest-epoch share"
          value={livePct > 0 ? `${livePct.toFixed(2)}%` : "—"}
          sub={
            baseline.method === "local-ts-heuristic-DEV-ONLY"
              ? "TS heuristic (dev)"
              : "canonical Rust solver"
          }
        />
        <DeltaCell direction={direction} delta={delta} />
      </div>

      <div className="border-t border-border px-4 py-3 flex items-start gap-2 text-xs text-cream-50">
        <Info className="size-3.5 shrink-0 mt-0.5" />
        <span className="leading-relaxed">{headlineCopy}</span>
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-surface px-4 py-4">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className="mt-1 text-2xl font-mono tabular-nums">{value}</div>
      {sub && (
        <div className="text-xs text-cream-40 font-mono mt-0.5">{sub}</div>
      )}
    </div>
  );
}

function DeltaCell({
  direction,
  delta,
}: {
  direction: "up" | "down" | "flat";
  delta: number;
}) {
  const Icon =
    direction === "up"
      ? ArrowUpRight
      : direction === "down"
      ? ArrowDownRight
      : Minus;
  const tone =
    direction === "up"
      ? "text-emerald-400"
      : direction === "down"
      ? "text-amber-400"
      : "text-cream-40";

  return (
    <div className="bg-surface px-4 py-4">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        Delta
      </div>
      <div className="mt-1 flex items-center gap-1">
        <Icon className={`size-5 ${tone}`} />
        <span className={`text-2xl font-mono tabular-nums ${tone}`}>
          {delta > 0 ? "+" : ""}
          {delta.toFixed(2)}pp
        </span>
      </div>
      <div className="text-xs text-cream-40 font-mono mt-0.5">
        live − all-time
      </div>
    </div>
  );
}
