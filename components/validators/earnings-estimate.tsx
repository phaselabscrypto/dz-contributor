"use client";

import Link from "next/link";

import { Stat } from "@/components/ui/stat";
import { ExtLink } from "@/components/ui/ext-link";
import { EmptyState } from "@/components/ui/states";
import { LAMPORTS_PER_SOL } from "@/lib/constants/config";
import { formatNumber, formatSolFromSol } from "@/lib/utils/format";
import { estimateValidatorTake } from "@/lib/utils/reward-estimator";
import type { EpochProjectionRate } from "@/lib/utils/epoch-rate";
import type { Publisher } from "@/lib/types/publisher";
import type { ValidatorStakeResponse } from "@/lib/types/validator-stake";

/**
 * Why a validator does or does not earn from the validator pool.
 *
 * Three states, not two. Eligibility needs leader shreds AND no retransmits,
 * so a retransmitting validator cannot fix its status by connecting and its
 * copy has to differ from one that simply has not joined.
 */
type Participation =
  | { kind: "eligible" }
  | { kind: "blocked"; reason: "no-shreds" | "retransmitting" }
  | { kind: "absent" };

function participationOf(publisher: Publisher | null): Participation {
  if (!publisher) return { kind: "absent" };
  if (publisher.publishing_retransmitted)
    return { kind: "blocked", reason: "retransmitting" };
  if (!publisher.publishing_leader_shreds)
    return { kind: "blocked", reason: "no-shreds" };
  return { kind: "eligible" };
}

/** Status line, and the lead-in above the tiles. These two carry the whole
 *  difference between modes, so the grid below never changes shape. */
function framing(p: Participation): { status: string; leadIn: string } {
  switch (p.kind) {
    case "eligible":
      return { status: "on DoubleZero · earning", leadIn: "Its current share:" };
    case "blocked":
      return p.reason === "retransmitting"
        ? {
            status: "on DoubleZero · publishing retransmits, so not eligible",
            leadIn: "If it stopped retransmitting and published leader shreds:",
          }
        : {
            status: "on DoubleZero · not publishing leader shreds",
            leadIn: "If it started publishing leader shreds:",
          };
    case "absent":
      return {
        status: "not on DoubleZero",
        leadIn: "If it connected and published leader shreds:",
      };
  }
}

export function EarningsEstimate({
  stake,
  publisher,
  eligibleStakeLamports,
  averageFeeSol,
  epochs,
  contributorCode,
  contributorName,
}: {
  stake: ValidatorStakeResponse;
  /** The matching publisher row, when this validator is in the feed. */
  publisher: Publisher | null;
  eligibleStakeLamports: number;
  /** Null when the fee feed is unavailable. Hides the SOL figures. */
  averageFeeSol: number | null;
  epochs: EpochProjectionRate;
  contributorCode?: string;
  contributorName?: string;
}) {
  const participation = participationOf(publisher);
  const isCounterfactual = participation.kind !== "eligible";
  const { status, leadIn } = framing(participation);

  // Feed stake wins for a feed member so this and the table below can never
  // disagree about the same validator. RPC is the source only for a validator
  // the feed has never heard of.
  const activatedStakeLamports = publisher
    ? publisher.activated_stake
    : stake.activatedStake;

  const estimate = estimateValidatorTake({
    activatedStakeLamports,
    eligibleStakeLamports,
    // An eligible validator is already inside the sum, so adding its stake
    // again would inflate the denominator and understate its own share.
    countedInEligibleStake: participation.kind === "eligible",
    averageFeeSol,
    epochs,
  });

  const name = publisher?.validator_name || "Unknown validator";
  const sol = (v: number | null, digits = 2) =>
    v === null ? "—" : `${formatSolFromSol(v, digits)} SOL`;
  const sharePct = (estimate.stakeShare * 100).toFixed(3);

  if (!stake.hasStake && !publisher) {
    return (
      <div className="space-y-2">
        <p className="text-sm">
          {name} <span className="text-cream-30">· {status}</span>
        </p>
        <EmptyState
          title="No activated stake"
          message="This vote account has no activated stake this epoch, so its share of the validator pool is zero. The estimate scales with stake and will change as stake is delegated."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="sr-only" aria-live="polite">
        {isCounterfactual
          ? `${name} earns nothing today. If connected it would take ${sharePct} percent of the validator pool.`
          : `${name} takes ${sharePct} percent of the validator pool.`}
      </p>

      <div className="space-y-1">
        <p className="text-sm">
          <span className="font-display text-lg">{name}</span>
          <span className="text-cream-30"> · {status}</span>
        </p>
        <p className="text-xs font-mono text-cream-30">
          {formatNumber(activatedStakeLamports / LAMPORTS_PER_SOL, 0)} SOL
          activated stake
          {stake.delinquent && " · delinquent"}
        </p>
      </div>

      <p className="text-xs text-cream-60">{leadIn}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
        <Stat
          label="Stake share"
          value={`${sharePct}%`}
          // A counterfactual denominator differs from the table's, and the
          // grid has to say so on its own, in a screenshot of just the tiles.
          sub={`of ${formatNumber(estimate.eligibleStakeLamports / LAMPORTS_PER_SOL, 0)} SOL${isCounterfactual ? " incl. this validator" : ""}`}
        />
        <Stat
          label="Per epoch"
          value={sol(estimate.perEpochSol, 4)}
          // The zero lives inside the tile block so it survives a screenshot
          // of just the grid.
          sub={isCounterfactual ? "today 0 SOL" : undefined}
        />
        <Stat label="Per month" value={sol(estimate.monthlySol)} />
        <Stat label="Per year" value={sol(estimate.yearlySol)} />
      </div>

      <p className="text-xs text-cream-30 leading-relaxed">
        {isCounterfactual &&
          `Existing validators' shares fall ${sharePct}%. Assumes no other joiner and an unchanged pool. `}
        Operators take 29.25% of total fees, split by activated stake.{" "}
        <Link href="/methodology" className="underline decoration-dotted">
          How this works
        </Link>
        {publisher && (
          <>
            {" · "}
            <ExtLink
              href={`https://explorer.solana.com/address/${stake.votePubkey}`}
            >
              Explorer
            </ExtLink>
          </>
        )}
        {contributorCode && (
          <>
            {" · "}
            <Link
              href={`/contributors/${contributorCode}`}
              className="underline decoration-dotted"
            >
              {contributorName ?? contributorCode}
            </Link>
          </>
        )}
        {!publisher && (
          <>
            {" · "}
            <ExtLink
              href={`https://explorer.solana.com/address/${stake.votePubkey}`}
            >
              Explorer
            </ExtLink>
          </>
        )}
      </p>
    </div>
  );
}
