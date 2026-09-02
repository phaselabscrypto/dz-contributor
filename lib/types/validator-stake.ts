// Wire shape for GET /api/validators/stake, shared with
// `lib/hooks/use-validator-stake.ts` so the two cannot drift.

import type { PubkeyRejectReason } from "@/lib/utils/pubkey";

/** Machine-readable advisories. None of these is an error condition. */
export type StakeWarning =
  | "delinquent"
  | "zero-stake"
  | "not-epoch-vote-account"
  | "identity-match";

/**
 * One vote account's stake, read from Solana.
 *
 * Deliberately says nothing about DoubleZero. Whether the validator is in the
 * publisher feed is joined on the client, which already holds that array to
 * compute the eligible-stake denominator; fetching it again here would either
 * duplicate the feed logic or self-call our own route.
 */
export interface ValidatorStakeResponse {
  /** The validated pubkey as supplied, case preserved. */
  pubkey: string;
  votePubkey: string;
  nodePubkey: string;
  /** Lamports, matching Publisher.activated_stake so the two stake sources
   *  stay interchangeable. */
  activatedStake: number;
  activatedStakeSol: number;
  /** Sentinel so the UI never compares a float to zero. */
  hasStake: boolean;
  delinquent: boolean;
  /** False when the account holds no stake at the epoch boundary. */
  epochVoteAccount: boolean;
  commission: number;
  lastVote: number;
  /** Which key matched. `identity` means the caller pasted a node identity,
   *  which the UI can offer to correct. */
  matchedBy: "vote" | "identity";
  warnings: StakeWarning[];
  source: "rpc";
}

/**
 * Every non-200 body. `hasStake` and `activatedStake` are always present so
 * the client renders one empty state without branching on status code.
 *
 * `reason` appears on 400 only. It describes the caller's own input, so it is
 * safe to return. Nothing here echoes the input itself, names an upstream
 * host, or carries an error message from a dependency.
 */
export interface ValidatorStakeError {
  error: string;
  reason?: PubkeyRejectReason;
  hasStake: false;
  activatedStake: 0;
}
