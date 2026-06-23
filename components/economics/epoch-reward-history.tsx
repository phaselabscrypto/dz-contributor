"use client";

import { useMemo } from "react";
import { Sparkline } from "@/components/ui/sparkline";
import { useEconomicHub } from "@/lib/hooks/use-live";
import { Info } from "lucide-react";

interface Props {
  /** Optional contributor code. When provided we'll surface per-contributor
   * history once DZ exposes it; until then we show pool-level history with a
   * disclaimer that per-contributor breakdown is pending. */
  contributorCode?: string;
}

/**
 * Per-epoch reward distribution chart. Renders global pool by default,
 * with a slot for per-contributor data once available (DZ Question #9).
 *
 * Today's economic-hub feed only exposes:
 *   - epochs[]          — list of distributed Solana epochs
 *   - totalDistributed2Z — cumulative
 *   - reward_percentage  — all-time per contributor
 *
 * To turn the cumulative into a per-epoch series, we evenly attribute the
 * total across the listed epochs. This is wrong but visually directional —
 * the chart label is honest about it. As soon as DZ exposes
 * `(contributor, epoch) → 2Z_paid`, we swap the data source and the chart
 * becomes accurate.
 */
export function EpochRewardHistory({ contributorCode }: Props) {
  const { data: hub } = useEconomicHub();

  const series = useMemo(() => {
    if (!hub) return [];
    if (hub.epochs.length === 0) return [];

    // Global average per epoch (until per-epoch data exists).
    const avgPerEpoch = hub.totalDistributed2Z / hub.epochs.length;

    // If a contributor code is supplied, scale by their all-time share.
    if (contributorCode) {
      const ehHit = hub.contributors.find((c) => {
        // Use the same name→code transform as elsewhere — accept either form.
        const eh = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        const target = contributorCode.toLowerCase().replace(/[^a-z0-9]/g, "");
        return (
          c.name.toLowerCase().includes(contributorCode.toLowerCase()) ||
          eh === target
        );
      });
      const sharePct = ehHit?.rewardPercentage ?? 0;
      const perEpoch = avgPerEpoch * (sharePct / 100);
      return hub.epochs.map(() => perEpoch);
    }

    return hub.epochs.map(() => avgPerEpoch);
  }, [hub, contributorCode]);

  if (!hub || hub.epochs.length === 0) return null;

  const first = hub.epochs[0];
  const last = hub.epochs[hub.epochs.length - 1];

  return (
    <div className="border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          {contributorCode ? "Estimated reward history" : "Pool history"}
        </span>
        <span className="text-xs text-muted-foreground font-mono">
          {first} → {last}
        </span>
      </div>
      <Sparkline
        data={series}
        width={1000}
        height={56}
        className="w-full text-cream-60"
      />
      <div className="mt-3 flex items-start gap-1.5 text-xs text-cream-40 leading-snug">
        <Info className="size-3 mt-0.5 shrink-0" />
        <span>
          Per-epoch values are estimated by spreading the cumulative on-chain
          distribution evenly across {hub.epochs.length} distributed epochs
          {contributorCode ? " and applying this contributor's all-time share" : ""}.
          A real per-epoch feed (DZ&nbsp;Q9) will replace this estimate as
          soon as it&apos;s available.
        </span>
      </div>
    </div>
  );
}
