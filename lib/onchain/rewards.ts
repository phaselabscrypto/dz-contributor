/**
 * On-chain reward distribution reader.
 *
 * Reads contributor-rewards records directly from the DZ ledger
 * (separate Solana cluster from mainnet). Each epoch's record is an
 * account owned by the doublezero-record program at a deterministic
 * address derived from `[b"dz_contributor_rewards", epoch_u64_le,
 * b"shapley_output"]` via `create_with_seed` rooted at the rewards
 * accountant key.
 *
 * Payload format and address derivation are verified end-to-end against
 * live epoch 117 — see `scripts/verify-derive-and-decode.ts`.
 *
 * The earlier per-validator-payout shape in this module was a guess
 * before DZ Foundation confirmed the schema. The on-chain record only stores
 * the per-contributor unit_shares; validator payouts are derived
 * off-chain from publishing-stake distribution (see `/validators`).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  DZ_RECORD_PROGRAM_ID,
  requireDzLedgerRpc,
  REWARDS_ACCOUNTANT_MAINNET,
  decodeShapleyOutputStorage,
  deriveContributorRewardsAddress,
  unitShareToFraction,
  type RewardShare,
} from "./dz-rewards-record";

export interface OnchainContributorPayout {
  /** Contributor's on-chain owner pubkey (base58). */
  contributorKey: string;
  /** Fixed-point share — 0 to 1,000,000,000. */
  unitShare: number;
  /** 0–1 fraction of the contributor pool. */
  share: number;
  /** Whether this contributor is blocked from receiving rewards. */
  isBlocked: boolean;
}

export interface OnchainEpochReward {
  /** Solana epoch number (matches DZ records). */
  epoch: number;
  /** On-chain record account address. */
  recordAddress: string;
  /** Number of contributors in the distribution. */
  contributorCount: number;
  /** Per-contributor unit_share breakdown. */
  contributors: OnchainContributorPayout[];
  /** `total_unit_shares` as stored on chain — may differ from the
   *  actual sum by ±5 due to float→fixed rounding. */
  totalUnitSharesStored: number;
}

export interface OnchainRewardHistory {
  epochs: OnchainEpochReward[];
  source: "onchain";
  fetchedAt: string;
  // NO rpcUrl here: this shape is served verbatim by /api/onchain/rewards,
  // and the resolved URL embeds the provider API key in its path — it
  // leaked a live Alchemy key to the public until removed (2026-07-21).
}

function rewardShareToPayload(r: RewardShare): OnchainContributorPayout {
  return {
    contributorKey: r.contributorKey,
    unitShare: r.unitShare,
    share: unitShareToFraction(r.unitShare),
    isBlocked: r.isBlocked,
  };
}

/**
 * Fetch a single epoch's reward distribution from the DZ ledger.
 * Returns null if the record account doesn't exist for that epoch.
 */
export async function fetchOnchainEpochReward(
  epoch: number,
  options: {
    rpcUrl?: string;
    rewardsAccountant?: PublicKey;
  } = {},
): Promise<OnchainEpochReward | null> {
  const rpcUrl = options.rpcUrl ?? requireDzLedgerRpc();
  const accountant = options.rewardsAccountant ?? REWARDS_ACCOUNTANT_MAINNET;
  const conn = new Connection(rpcUrl, "confirmed");

  const addr = deriveContributorRewardsAddress(epoch, accountant);
  const info = await conn.getAccountInfo(addr, "confirmed");
  if (!info) return null;

  const data = new Uint8Array(info.data);
  const storage = decodeShapleyOutputStorage(data);

  return {
    epoch: storage.epoch,
    recordAddress: addr.toBase58(),
    contributorCount: storage.rewards.length,
    contributors: storage.rewards.map(rewardShareToPayload),
    totalUnitSharesStored: storage.totalUnitShares,
  };
}

/**
 * Discover every live contributor-rewards record on the DZ ledger via a
 * single `getProgramAccounts` call filtered by the rewards_accountant
 * key (stored at bytes 1..33 of every record). Decodes each matching
 * record's payload in place — callers should consume the returned
 * `OnchainEpochReward[]` directly instead of re-fetching by address.
 *
 * No `dataSize` filter is applied because record size scales with the
 * contributor set (~609 bytes for 14 contributors today, larger as the
 * set grows). Payload validity is checked by `decodeShapleyOutputStorage`,
 * which silently skips records owned by the same authority but with
 * different schemas (reward-input, telemetry, etc.).
 */
export async function discoverContributorRewardsRecords(
  options: { rpcUrl?: string; rewardsAccountant?: PublicKey } = {},
): Promise<OnchainEpochReward[]> {
  const rpcUrl = options.rpcUrl ?? requireDzLedgerRpc();
  const accountant = options.rewardsAccountant ?? REWARDS_ACCOUNTANT_MAINNET;
  const conn = new Connection(rpcUrl, "confirmed");

  const accounts = await conn.getProgramAccounts(DZ_RECORD_PROGRAM_ID, {
    filters: [
      // authority at bytes 1..33 must match rewards_accountant
      { memcmp: { offset: 1, bytes: accountant.toBase58() } },
    ],
  });

  const records: OnchainEpochReward[] = [];
  for (const { pubkey, account } of accounts) {
    const data = new Uint8Array(account.data);
    // contributor-rewards payloads start with epoch u64 LE at offset 33;
    // need at least 33 (header) + 12 (epoch u64 + vec u32 prefix) bytes.
    if (data.length < 33 + 12) continue;
    try {
      const storage = decodeShapleyOutputStorage(data);
      // Reward-input + telemetry records owned by the same authority
      // won't have a non-empty rewards vec. Filter them out.
      if (storage.rewards.length === 0) continue;
      records.push({
        epoch: storage.epoch,
        recordAddress: pubkey.toBase58(),
        contributorCount: storage.rewards.length,
        contributors: storage.rewards.map(rewardShareToPayload),
        totalUnitSharesStored: storage.totalUnitShares,
      });
    } catch {
      // Not a contributor-rewards record (different schema sharing
      // authority). Skip.
    }
  }
  records.sort((a, b) => a.epoch - b.epoch);
  return records;
}

/**
 * Fetch reward distribution history across all live contributor-rewards
 * records on the DZ ledger. Uses `discoverContributorRewardsRecords` to
 * avoid blind-probing 100+ epochs.
 */
export async function fetchOnchainRewardHistory(
  options: {
    rpcUrl?: string;
    rewardsAccountant?: PublicKey;
    /** Cap on number of epochs returned. Default: return all. */
    limit?: number;
  } = {},
): Promise<OnchainRewardHistory> {
  const rpcUrl = options.rpcUrl ?? requireDzLedgerRpc();
  const accountant = options.rewardsAccountant ?? REWARDS_ACCOUNTANT_MAINNET;

  // Discovery returns fully-decoded OnchainEpochReward records in a single
  // RPC roundtrip — no further per-account fetches are needed.
  const discovered = await discoverContributorRewardsRecords({
    rpcUrl,
    rewardsAccountant: accountant,
  });

  const epochs = options.limit
    ? discovered.slice(-options.limit)
    : discovered;

  return {
    epochs,
    source: "onchain",
    fetchedAt: new Date().toISOString(),
  };
}
