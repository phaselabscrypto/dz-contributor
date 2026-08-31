"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/states";
import { ValidatorRewards } from "@/components/validators/validator-rewards";
import { usePublishers } from "@/lib/hooks/use-publishers";
import { useFees } from "@/lib/hooks/use-fees";
import { useLiveTopology } from "@/lib/hooks/use-live";
import { useEpochRate } from "@/lib/hooks/use-epoch-rate";
import { parseAsString, useQueryState } from "@/lib/hooks/use-url-state";
import { validatePubkey } from "@/lib/utils/pubkey";
import { computeValidatorRewards } from "@/lib/utils/reward-estimator";

function ValidatorsInner() {
  const {
    data: publishers,
    isLoading: pubLoading,
    error: pubError,
    mutate,
  } = usePublishers();
  const { data: feeHistory, isLoading: feeLoading } = useFees();
  const { data: topology } = useLiveTopology();
  const epochs = useEpochRate();

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
    return computeValidatorRewards(
      publishers,
      avgFeeSol,
      epochs,
      deviceToContrib,
    );
  }, [publishers, feeHistory, epochs, deviceToContrib]);

  const isLoading = pubLoading || feeLoading;

  // Hand the table's search to the calculator only when it is already a valid
  // pubkey. The search is fuzzy over names, metros and pubkey prefixes, so
  // piping it through unconditionally would usually land the calculator on an
  // invalid-input error, which is worse than passing nothing.
  const [tableSearch] = useQueryState("q", parseAsString.withDefault(""));
  const parsedSearch = validatePubkey(tableSearch);
  const calculatorHref = parsedSearch.ok
    ? `/validators/calculator?vote=${parsedSearch.pubkey}`
    : "/validators/calculator";

  return (
    <>
      <PageHeader
        title="Validators"
        description="Publishing validators on DoubleZero — stake-weighted projected SOL share of the validator pool (29.25% of total fees, or 32.5% of after-burn fees). Quality signals: leader-shred publishing and multicast connection."
      />
      <div className="flex-1 px-4 py-4 sm:px-6 sm:py-6 space-y-4">
        <Link
          href={calculatorHref}
          className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-[0.12em] border border-cream-15 hover:border-cream-30 hover:bg-cream-8 px-3 py-1.5 transition-colors"
        >
          ⚡ Estimate earnings for any vote account
        </Link>
        {pubError ? (
          <ErrorState
            title="Couldn't load publishers"
            message="The DoubleZero publisher feed did not respond."
            onRetry={() => mutate()}
          />
        ) : (
          <ValidatorRewards rewards={rewards} isLoading={isLoading} />
        )}
      </div>
    </>
  );
}

export default function ValidatorsPage() {
  return (
    <Suspense fallback={null}>
      <ValidatorsInner />
    </Suspense>
  );
}
