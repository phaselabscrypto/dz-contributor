"use client";

import { useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { ValidatorRewards } from "@/components/validators/validator-rewards";
import { usePublishers } from "@/lib/hooks/use-publishers";
import { useFees } from "@/lib/hooks/use-fees";
import { useLiveTopology } from "@/lib/hooks/use-live";
import { computeValidatorRewards } from "@/lib/utils/reward-estimator";

export default function ValidatorsPage() {
  const { data: publishers, isLoading: pubLoading, error: pubError } =
    usePublishers();
  const { data: feeHistory, isLoading: feeLoading } = useFees();
  const { data: topology } = useLiveTopology();

  // device_code → contributor_code join from the live topology, so we can
  // surface "Validator runs on Galaxy's frankfurt device" without making
  // assumptions about the publisher feed shape.
  const deviceToContrib = useMemo(() => {
    const m = new Map<string, string>();
    if (topology) {
      for (const d of topology.devices) {
        if (d.code) m.set(d.code, d.contributorCode);
      }
    }
    return m;
  }, [topology]);

  const rewards = useMemo(() => {
    if (!publishers) return null;
    // computeValidatorRewards expects fees in SOL. The validator pool is
    // paid in SOL. Fall back to 0 (not lamports) when the value is missing —
    // a lamport fallback would silently inflate the pool by 1e9×.
    const avgFeeSol = feeHistory?.averageFeeSol ?? 0;
    return computeValidatorRewards(publishers, avgFeeSol, deviceToContrib);
  }, [publishers, feeHistory, deviceToContrib]);

  const isLoading = pubLoading || feeLoading;

  return (
    <>
      <PageHeader
        title="Validators"
        description="Publishing validators on DoubleZero — stake-weighted projected SOL share of the 45% validator pool. Quality signals: leader-shred publishing and multicast connection."
      />
      <div className="flex-1 px-4 py-4 sm:px-6 sm:py-6 space-y-4">
        <Link
          href="/validators/calculator"
          className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-[0.12em] border border-cream-15 hover:border-cream-30 hover:bg-cream-8 px-3 py-1.5 transition-colors"
        >
          ⚡ Earnings calculator — paste a vote pubkey
        </Link>
        {pubError ? (
          <div className="border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">
            Failed to load publisher data: {(pubError as Error).message}
          </div>
        ) : (
          <ValidatorRewards rewards={rewards} isLoading={isLoading} />
        )}
      </div>
    </>
  );
}
