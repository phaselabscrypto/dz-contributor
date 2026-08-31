"use client";

import Link from "next/link";

import { Stat } from "@/components/ui/stat";
import { ExtLink } from "@/components/ui/ext-link";
import { EmptyState } from "@/components/ui/states";
import { LAMPORTS_PER_SOL } from "@/lib/constants/config";
import { formatNumber, formatSolFromSol, shortenPubkey } from "@/lib/utils/format";
import { estimateValidatorTake } from "@/lib/utils/reward-estimator";
import type { EpochProjectionRate } from "@/lib/utils/epoch-rate";
import type { Publisher } from "@/lib/types/publisher";
import type { ValidatorStakeResponse } from "@/lib/types/validator-stake";

/**
 * Why a validator does or does not earn from the validator pool.
 *
 * Three states, not two. Eligibility needs leader shreds AND no retransmits,
 * so a retransmitting validator cannot fix its status by connecting and its
 * copy has to say something different from a validator that simply has not
 * joined.
 */
export type Participation =
  | { kind: "eligible" }
  | { kind: "blocked"; reason: "no-shreds" | "retransmitting" }
  | { kind: "absent" };

export function participationOf(publisher: Publisher | null): Participation {
  if (!publisher) return { kind: "absent" };
  if (publisher.publishing_retransmitted)
    return { kind: "blocked", reason: "retransmitting" };
  if (!publisher.publishing_leader_shreds)
    return { kind: "blocked", reason: "no-shreds" };
  return { kind: "eligible" };
}

const BANNERS: Record<string, string> = {
  absent:
    "This validator is not on DoubleZero, so it earns nothing from the validator pool today. The figures below are what it would earn at its current stake if it connected and published leader shreds. They assume no other validator joins at the same time and the fee pool does not change. Existing validators' shares fall by the same percentage shown here.",
  "no-shreds":
    "This validator is on DoubleZero but is not publishing leader shreds, so it earns nothing from the validator pool today. The figures below are what it would earn at its current stake if it started publishing.",
  retransmitting:
    "This validator publishes retransmitted shreds, which makes it ineligible for the validator pool. The figures below assume it stops publishing retransmits and publishes leader shreds.",
  eligible:
    "This validator is eligible for the validator pool. The figures below are its projected share at current stake and current fee levels.",
};

function bannerKey(p: Participation): string {
  return p.kind === "blocked" ? p.reason : p.kind;
}

export function EarningsEstimate({
  stake,
  publisher,
  eligibleStakeLamports,
  averageFeeSol,
  epochs,
  feedEpoch,
  contributorCode,
  contributorName,
}: {
  stake: ValidatorStakeResponse;
  /** The matching publisher row, when this validator is in the feed. */
  publisher: Publisher | null;
  eligibleStakeLamports: number;
  /** Null when the fee feed is unavailable. Drives the hidden SOL figures. */
  averageFeeSol: number | null;
  epochs: EpochProjectionRate;
  feedEpoch: number | null;
  contributorCode?: string;
  contributorName?: string;
}) {
  const participation = participationOf(publisher);
  const isCounterfactual = participation.kind !== "eligible";

  // Feed stake wins for a feed member, so the calculator and /validators can
  // never disagree about the same validator. RPC is the source only for a
  // validator the feed has never heard of.
  const activatedStakeLamports = publisher
    ? publisher.activated_stake
    : stake.activatedStake;

  const estimate = estimateValidatorTake({
    activatedStakeLamports,
    eligibleStakeLamports,
    // An already-eligible validator is inside the sum, so adding its stake
    // again would inflate the denominator and understate its own share.
    countedInEligibleStake: participation.kind === "eligible",
    averageFeeSol,
    epochs,
  });

  const suffix = isCounterfactual ? " if connected" : "";
  const sol = (v: number | null, digits = 2) =>
    v === null ? "—" : `${formatSolFromSol(v, digits)} SOL`;
  const eligibleSol = estimate.eligibleStakeLamports / LAMPORTS_PER_SOL;

  const liveSummary = isCounterfactual
    ? `${publisher?.validator_name || shortenPubkey(stake.votePubkey)} earns nothing today. If connected it would take ${(estimate.stakeShare * 100).toFixed(3)} percent of the validator pool.`
    : `${publisher?.validator_name || shortenPubkey(stake.votePubkey)} takes ${(estimate.stakeShare * 100).toFixed(3)} percent of the validator pool.`;

  return (
    <div className="space-y-6">
      <p className="sr-only" aria-live="polite">
        {liveSummary}
      </p>

      {/* Identity */}
      <div className="border border-border bg-surface p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-xl">
            {publisher?.validator_name || "Unknown validator"}
          </span>
          {participation.kind === "absent" ? (
            <span className="rounded-full border border-cream-15 text-cream-60 px-1.5 py-0.5 text-xs font-mono uppercase tracking-[0.1em]">
              Not on DoubleZero
            </span>
          ) : (
            <>
              <span className="rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 text-xs font-mono uppercase tracking-[0.1em]">
                On DoubleZero
              </span>
              <span
                className={
                  participation.kind === "eligible"
                    ? "rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 text-xs font-mono uppercase tracking-[0.1em]"
                    : "rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 text-xs font-mono uppercase tracking-[0.1em]"
                }
              >
                {participation.kind === "eligible" ? "Earning" : "Not earning"}
              </span>
            </>
          )}
          {publisher?.multicast_connected && (
            <span className="rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/30 px-1.5 py-0.5 text-xs font-mono uppercase tracking-[0.1em]">
              Multicast
            </span>
          )}
        </div>

        <div className="text-xs font-mono text-cream-30 break-all">
          vote {stake.votePubkey}
        </div>
        <div className="text-xs font-mono text-cream-30 break-all">
          node {stake.nodePubkey}
        </div>

        <div className="text-xs font-mono text-cream-30">
          {publisher
            ? `Stake from the DoubleZero publisher feed${feedEpoch !== null ? `, epoch ${feedEpoch}` : ""}.`
            : "Stake from Solana RPC."}{" "}
          {formatNumber(activatedStakeLamports / LAMPORTS_PER_SOL, 0)} SOL
          activated.
        </div>

        {stake.delinquent && (
          <p className="bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-300">
            Solana reports this validator as delinquent. The estimate uses its
            activated stake, which is still counted. A delinquent validator may
            not be producing blocks.
          </p>
        )}

        <div className="flex flex-wrap gap-4 pt-2 text-xs">
          {publisher ? (
            <Link
              href={`/validators?q=${stake.votePubkey}`}
              className="text-cream-60 hover:text-cream underline decoration-dotted underline-offset-2"
            >
              Open in /validators
            </Link>
          ) : (
            <span className="text-cream-30">
              Not listed in /validators, which shows connected validators only.
            </span>
          )}
          {contributorCode && (
            <Link
              href={`/contributors/${contributorCode}`}
              className="text-cream-60 hover:text-cream underline decoration-dotted underline-offset-2"
            >
              Contributor {contributorName ?? contributorCode}
            </Link>
          )}
          <ExtLink
            href={`https://explorer.solana.com/address/${stake.votePubkey}`}
            className="text-cream-60"
          >
            Solana Explorer
          </ExtLink>
        </div>
      </div>

      {/* Scenario */}
      <p
        className={
          isCounterfactual
            ? "bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-200"
            : "border border-border bg-surface px-3 py-2 text-xs text-cream-60"
        }
      >
        {BANNERS[bannerKey(participation)]}
      </p>

      {!stake.hasStake && !publisher ? (
        <EmptyState
          title="No activated stake"
          message="This vote account has no activated stake this epoch, so its share of the validator pool is zero. The estimate scales with stake and will change as stake is delegated."
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
          <Stat
            label={`Stake share${suffix}`}
            value={`${(estimate.stakeShare * 100).toFixed(3)}%`}
            sub={`of ${formatNumber(eligibleSol, 0)} SOL eligible stake${
              isCounterfactual ? ", including this validator" : ""
            }`}
          />
          <Stat
            label={`Per epoch${suffix}`}
            value={sol(estimate.perEpochSol, 4)}
            sub={isCounterfactual ? "Today 0 SOL" : undefined}
          />
          <Stat
            label={`Per month${suffix}`}
            value={sol(estimate.monthlySol)}
            sub={`${epochs.perMonth.toFixed(1)} epochs`}
          />
          <Stat
            label={`Per year${suffix}`}
            value={sol(estimate.yearlySol)}
            sub={`${epochs.perYear.toFixed(0)} epochs`}
          />
        </div>
      )}

      <div className="text-xs text-cream-30 font-mono leading-relaxed space-y-2">
        <p>
          The validator pool is 45% of average per-epoch fee revenue, which is{" "}
          {sol(estimate.validatorPoolSol)} at current levels. That 45% covers
          validator operators and their clients together. Operators keep 65% of
          it, which is 29.25% of total fees or 32.5% of after-burn fees. The
          remaining 35% goes to clients.
        </p>
        <p>
          The pool is split by activated stake across eligible validators.
          Eligibility requires publishing leader shreds and not publishing
          retransmitted shreds. Multicast connection is shown as a quality
          signal and does not change this estimate. A validator that stops
          publishing leader shreds receives nothing from the validator pool. See{" "}
          <Link href="/methodology" className="underline decoration-dotted">
            /methodology
          </Link>{" "}
          for the full formula.
        </p>
      </div>
    </div>
  );
}
