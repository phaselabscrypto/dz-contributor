import {
  VALIDATOR_SHARE,
  VALIDATOR_TAKE_OF_POOL,
} from "@/lib/constants/config";
import type { EpochProjectionRate } from "@/lib/utils/epoch-rate";
import type { FeeHistory } from "@/lib/types/fees";
import type {
  Publisher,
  PublisherCheckResponse,
  ValidatorRewardProjection,
  ValidatorRewardsSummary,
} from "@/lib/types/publisher";

/**
 * Whether a validator earns from the validator pool this epoch.
 *
 * Confirmed by the DoubleZero Foundation: eligibility needs leader shreds AND
 * no retransmits. Failing either pays nothing. Retransmitting is not something
 * a validator can override its way out of, unlike simply not publishing yet.
 */
export function isPublisherEligible(
  p: Pick<Publisher, "publishing_leader_shreds" | "publishing_retransmitted">,
): boolean {
  return (
    p.publishing_leader_shreds === true && p.publishing_retransmitted === false
  );
}

/** Sum of activated stake over currently-eligible publishers, in lamports.
 *  This is the denominator of every stake share. */
export function sumEligibleStakeLamports(
  data: PublisherCheckResponse,
): number {
  return data.publishers
    .filter(isPublisherEligible)
    .reduce((sum, p) => sum + p.activated_stake, 0);
}

export interface ValidatorEstimateInput {
  /** Subject's activated stake, in lamports. */
  activatedStakeLamports: number;
  /** Sum over currently-eligible publishers, in lamports. */
  eligibleStakeLamports: number;
  /**
   * True when the subject is already inside `eligibleStakeLamports`.
   *
   * Set it wrong and the result is a plausible wrong number rather than a
   * crash, which is why it is an explicit flag at every call site instead of
   * something this function infers. For an already-eligible validator the
   * stake must NOT be added again: doing so inflates the denominator and
   * understates its own share.
   */
  countedInEligibleStake: boolean;
  /** Mean per-epoch fee revenue in SOL. Null when the fee feed is down. */
  averageFeeSol: number | null;
  epochs: EpochProjectionRate;
}

export interface ValidatorEstimate {
  validatorPoolSol: number | null;
  /** The denominator actually used, in lamports. */
  eligibleStakeLamports: number;
  /** 0 to 1. */
  stakeShare: number;
  perEpochSol: number | null;
  monthlySol: number | null;
  yearlySol: number | null;
}

/**
 * A validator's take from the validator pool.
 *
 * Single source of the published formula
 * (`/methodology`, `/api/methodology`):
 *
 *   validator_pool = average_fee_per_epoch_SOL x VALIDATOR_SHARE
 *   operator_share = activated_stake / sum(eligible_stake)
 *   take_per_epoch = operator_share x validator_pool x VALIDATOR_TAKE_OF_POOL
 *
 * Participation-agnostic on purpose. Pass `countedInEligibleStake: false` to
 * ask what a validator outside the eligible set would earn if it joined; the
 * subject's own stake then enters the denominator, which is the arithmetically
 * honest answer and means every current validator's share falls by the same
 * proportion the newcomer gains.
 *
 * @returns SOL figures, or nulls for all of them when `averageFeeSol` is null.
 *   A null fee feed must not render as a confident 0 SOL, which is
 *   indistinguishable from a genuinely unstaked validator.
 */
export function estimateValidatorTake(
  input: ValidatorEstimateInput,
): ValidatorEstimate {
  const {
    activatedStakeLamports,
    countedInEligibleStake,
    averageFeeSol,
    epochs,
  } = input;

  const eligibleStakeLamports =
    input.eligibleStakeLamports +
    (countedInEligibleStake ? 0 : activatedStakeLamports);

  const stakeShare =
    eligibleStakeLamports > 0
      ? activatedStakeLamports / eligibleStakeLamports
      : 0;

  const validatorPoolSol =
    averageFeeSol === null ? null : averageFeeSol * VALIDATOR_SHARE;
  const perEpochSol =
    validatorPoolSol === null
      ? null
      : stakeShare * validatorPoolSol * VALIDATOR_TAKE_OF_POOL;

  return {
    validatorPoolSol,
    eligibleStakeLamports,
    stakeShare,
    perEpochSol,
    monthlySol: perEpochSol === null ? null : perEpochSol * epochs.perMonth,
    yearlySol: perEpochSol === null ? null : perEpochSol * epochs.perYear,
  };
}

/**
 * Compute a fee trend (simple linear regression over lamport totals).
 * Returns lamports-per-epoch slope so callers can format as they see fit.
 */
export function computeFeeTrend(feeHistory: FeeHistory): {
  slope: number;
  direction: "growing" | "declining" | "stable";
} {
  const epochs = feeHistory.epochs;
  if (epochs.length < 2) return { slope: 0, direction: "stable" };

  const n = epochs.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += epochs[i].totalFeeLamports;
    sumXY += i * epochs[i].totalFeeLamports;
    sumXX += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);

  const direction =
    slope > 0.5 ? "growing" : slope < -0.5 ? "declining" : "stable";

  return { slope, direction };
}

/**
 * Compute projected validator rewards from publisher data and historical
 * average per-epoch fees (in SOL). Publishing validators share the 45%
 * validator pool proportional to their activated_stake.
 *
 * Eligibility (confirmed by DZ Foundation, Q12):
 *   publishing leader shreds = true AND publishing retransmits = false.
 * Either failing → zero rewards.
 *
 * Validator's actual take is 65% of the stake-weighted pool share — the
 * other 35% goes to their clients.
 */
export function computeValidatorRewards(
  publisherData: PublisherCheckResponse,
  averageFeeSolPerEpoch: number,
  epochs: EpochProjectionRate,
  deviceCodeToContributor?: Map<string, string>,
): ValidatorRewardsSummary {
  const validatorPoolPerEpoch = averageFeeSolPerEpoch * VALIDATOR_SHARE;

  const publishingValidators =
    publisherData.publishers.filter(isPublisherEligible);
  const totalPublishingStake = sumEligibleStakeLamports(publisherData);

  const validators: ValidatorRewardProjection[] = publisherData.publishers.map(
    (p) => {
      // An ineligible row earns nothing, so it must not fall through to the
      // counterfactual: every non-publishing row in the /validators table
      // would suddenly show a number where it currently shows a dash.
      const estimate = isPublisherEligible(p)
        ? estimateValidatorTake({
            activatedStakeLamports: p.activated_stake,
            eligibleStakeLamports: totalPublishingStake,
            countedInEligibleStake: true,
            averageFeeSol: averageFeeSolPerEpoch,
            epochs,
          })
        : null;
      const stakeShare = estimate?.stakeShare ?? 0;
      const perEpoch = estimate?.perEpochSol ?? 0;

      return {
        nodePubkey: p.node_pubkey,
        votePubkey: p.vote_pubkey,
        validatorName: p.validator_name || "",
        activatedStake: p.activated_stake,
        stakeSharePercent: stakeShare * 100,
        publishingLeaderShreds: p.publishing_leader_shreds,
        leaderSlots: p.leader_slots,
        totalSlots: p.total_slots,
        dzMetroCode: p.dz_metro_code,
        dzDeviceCode: p.dz_device_code,
        validatorClient: p.validator_client,
        validatorVersion: p.validator_version,
        isBackup: p.is_backup,
        multicastConnected: p.multicast_connected,
        contributorCode: deviceCodeToContributor?.get(p.dz_device_code),
        projectedRewardPerEpochSol: perEpoch,
        projectedRewardMonthlySol: perEpoch * epochs.perMonth,
        projectedRewardYearlySol: perEpoch * epochs.perYear,
      };
    },
  );

  validators.sort((a, b) => b.stakeSharePercent - a.stakeSharePercent);

  return {
    epoch: publisherData.epoch,
    totalNetworkStake: publisherData.total_network_stake,
    publishingValidatorCount: publishingValidators.length,
    totalPublishingStake,
    projectedValidatorPoolPerEpochSol: validatorPoolPerEpoch,
    validators,
  };
}
