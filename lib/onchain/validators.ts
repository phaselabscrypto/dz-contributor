/**
 * NOT IMPLEMENTED
 *
 * On-chain validator-payout reader. Per-epoch SOL paid to publishing
 * validators from the 45% pool.
 *
 * Returns `{ epochs: [], source: "stub" }`. The body fetches program
 * accounts then discards them (see `void accounts`) because the payout
 * record layout has not been written.
 *
 * No IDL is needed. Verify the layout against a live payout account,
 * the way `dz-rewards-record.ts` verified the reward record. Then:
 *   1. Decode each account into `ValidatorEpochPayout` via borsh
 *   2. Remove the `void accounts;` line
 *   3. Check against a known epoch's payouts
 *   4. Drop the NOT IMPLEMENTED tag from this docstring
 *
 * See `lib/onchain/README.md` for the live-vs-stub matrix.
 * The `/api/onchain/validators` route is gated on `ONCHAIN_ENABLED` and
 * returns 503 cleanly until activation.
 */

import { getProgramId, ACCOUNT_DISCRIMINATORS } from "./program-ids";
import { getProgramAccounts } from "./client";

export interface ValidatorEpochPayout {
  /** DZ epoch */
  epoch: number;
  /** Solana epoch this distribution corresponds to (may differ) */
  solanaEpoch?: number;
  /** Total SOL paid this epoch to all validators */
  totalSol: number;
  /** Per-validator breakdown */
  validators: Array<{
    votePubkey: string;
    nodePubkey: string;
    /** SOL paid this epoch */
    paidSol: number;
    /** Stake at distribution time */
    activatedStake: number;
    /** Whether they were a leader-shred publisher this epoch */
    publishingLeaderShreds: boolean;
    /** Whether multicast was connected this epoch */
    multicastConnected: boolean;
  }>;
  slot: number;
  blockTime: number;
}

export interface ValidatorPayoutHistory {
  epochs: ValidatorEpochPayout[];
  source: "onchain" | "stub";
  fetchedAt: string;
}

export async function fetchOnchainValidatorPayouts(): Promise<
  ValidatorPayoutHistory
> {
  const programId = getProgramId("rewards");
  if (!programId) {
    throw new Error(
      "DZ_REWARDS_PROGRAM_ID not configured",
    );
  }

  // Filter by the validator-payout discriminator. 0x10 is an unverified
  // guess; check it against a live account.
  void ACCOUNT_DISCRIMINATORS.epochReward;

  const accounts = await getProgramAccounts(programId);
  void accounts;

  // TODO: decode each account into ValidatorEpochPayout via borsh schema.
  //
  // Expected shape, unverified:
  //   pub struct ValidatorEpochPayout {
  //       pub discriminator: [u8; 8],
  //       pub epoch: u64,
  //       pub solana_epoch: u64,
  //       pub total_sol: u64,
  //       pub validator_count: u32,
  //       // followed by `validator_count` of:
  //       //   pub vote_pubkey: Pubkey,
  //       //   pub node_pubkey: Pubkey,
  //       //   pub paid_sol: u64,
  //       //   pub activated_stake: u64,
  //       //   pub flags: u8,  // bit 0 = publishing, bit 1 = multicast
  //       pub recorded_slot: u64,
  //       pub block_time: i64,
  //   }

  return {
    epochs: [],
    source: "stub",
    fetchedAt: new Date().toISOString(),
  };
}
