import {
  CONTRIBUTOR_SHARE,
  VALIDATOR_SHARE,
  VALIDATOR_TAKE_OF_POOL,
  EPOCHS_PER_MONTH,
  EPOCHS_PER_YEAR,
} from "@/lib/constants/config";
import type { FeeHistory } from "@/lib/types/fees";
import type {
  PublisherCheckResponse,
  ValidatorRewardProjection,
  ValidatorRewardsSummary,
} from "@/lib/types/publisher";

/**
 * Estimate the SOL reward a contributor earns in one epoch given their
 * Shapley share and the average per-epoch fee revenue (in SOL).
 *
 * Pool math: contributors collectively receive CONTRIBUTOR_SHARE (45%)
 * of the per-epoch fee pool. Each contributor's slice is their Shapley
 * share of that 45%.
 */
export function estimateEpochRewardSol(
  contributorShare: number,
  averageFeeSolPerEpoch: number,
): number {
  return contributorShare * averageFeeSolPerEpoch * CONTRIBUTOR_SHARE;
}

/**
 * Project monthly and yearly earnings (in SOL) from a contributor's
 * Shapley share and the fee history. Solana epochs are ~2-3 days, so
 * roughly 10-15 per month.
 */
export function projectEarnings(
  contributorShare: number,
  feeHistory: FeeHistory,
): {
  perEpochSol: number;
  monthlySol: number;
  yearlySol: number;
} {
  const avgFeeSol = feeHistory.averageFeeSol ?? 0;
  const perEpoch = estimateEpochRewardSol(contributorShare, avgFeeSol);

  return {
    perEpochSol: perEpoch,
    monthlySol: perEpoch * EPOCHS_PER_MONTH,
    yearlySol: perEpoch * EPOCHS_PER_YEAR,
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
  deviceCodeToContributor?: Map<string, string>,
): ValidatorRewardsSummary {
  const validatorPoolPerEpoch = averageFeeSolPerEpoch * VALIDATOR_SHARE;

  const isEligible = (p: {
    publishing_leader_shreds: boolean;
    publishing_retransmitted: boolean;
  }) =>
    p.publishing_leader_shreds === true && p.publishing_retransmitted === false;

  const publishingValidators = publisherData.publishers.filter(isEligible);

  const totalPublishingStake = publishingValidators.reduce(
    (sum, p) => sum + p.activated_stake,
    0,
  );

  const validators: ValidatorRewardProjection[] = publisherData.publishers.map(
    (p) => {
      const eligible = isEligible(p);
      const stakeShare =
        eligible && totalPublishingStake > 0
          ? p.activated_stake / totalPublishingStake
          : 0;
      const perEpoch =
        stakeShare * validatorPoolPerEpoch * VALIDATOR_TAKE_OF_POOL;

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
        projectedRewardMonthlySol: perEpoch * EPOCHS_PER_MONTH,
        projectedRewardYearlySol: perEpoch * EPOCHS_PER_YEAR,
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
