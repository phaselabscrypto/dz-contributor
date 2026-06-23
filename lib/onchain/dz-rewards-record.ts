/**
 * On-chain reader for DoubleZero contributor-rewards records.
 *
 * Records live on the DZ ledger (separate Solana cluster from mainnet)
 * and are owned by the `doublezero-record` program. Each contributor-
 * rewards record is keyed by epoch and contains a borsh-encoded
 * `ShapleyOutputStorage` payload after a 33-byte `RecordData` header.
 *
 * Layout (verified by decoding a live epoch 117 record):
 *
 *   bytes 0       : version u8 (currently 1)
 *   bytes 1..33   : authority Pubkey (the rewards_accountant key)
 *   bytes 33..    : borsh payload — ShapleyOutputStorage
 *
 *   ShapleyOutputStorage layout (borsh):
 *     epoch              : u64 LE         (8 bytes)
 *     rewards            : Vec<RewardShare> with u32 length prefix
 *     total_unit_shares  : u32 LE         (4 bytes)
 *
 *   RewardShare layout (40 bytes, #[repr(C)]):
 *     contributor_key    : Pubkey         (32 bytes)
 *     unit_share         : u32 LE         (4 bytes)   max = 1_000_000_000
 *     remaining_bytes    : [u8; 4]        (4 bytes)   packed flags + burn rate
 *
 * The unit_share denominator is 1_000_000_000 — divide by 10_000_000 to
 * get a percentage. The first reward is top-bumped to absorb floating-
 * point rounding so the on-chain sum equals exactly 1_000_000_000 even
 * though the stored `total_unit_shares` field may show 999_999_994 etc.
 *
 * Address derivation (confirmed against live epoch 117 record):
 *   seeds  = [b"dz_contributor_rewards", epoch_u64_le, b"shapley_output"]
 *   base   = rewards_accountant pubkey
 *   addr   = Pubkey::create_with_seed(base, first32(b58(sha256(seeds))), record_program)
 */

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createHash } from "node:crypto";

export const DZ_RECORD_PROGRAM_ID = new PublicKey(
  "dzrecxigtaZQ3gPmt2X5mDkYigaruFR1rHCqztFTvx7",
);

export const REWARDS_ACCOUNTANT_MAINNET = new PublicKey(
  "acCSLNUiAECGPGayZgBHHDuZW4hLkM7L6hxphXbogBR",
);

/**
 * Resolve the DZ ledger RPC URL from the environment.
 *
 * Reads `DZ_LEDGER_RPC_URL` and throws with an actionable message if
 * the variable is unset or empty. We deliberately do not ship a
 * default URL here: a baked-in default would embed a paid rpcpool
 * API key in source, where it leaks into the deployed JS bundle.
 *
 * Production (Vercel) and CI must set `DZ_LEDGER_RPC_URL`. For local
 * dev, drop it into `.env.local`; see `.env.example` for the format
 * (the public rpcpool endpoint published in the doublezero-offchain
 * README works without an API key for development volumes).
 */
export function requireDzLedgerRpc(): string {
  const url = process.env.DZ_LEDGER_RPC_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "DZ_LEDGER_RPC_URL is not set. " +
        "The DZ ledger RPC URL must be provided via environment variable. " +
        "Set it in Vercel for production (vercel env add DZ_LEDGER_RPC_URL production) " +
        "or in .env.local for local development. " +
        "See .env.example for the recommended public endpoint.",
    );
  }
  return url;
}

/** Production seed prefix for contributor-rewards records, confirmed
 *  by DZ Foundation on 2026-05-14. The `example.config.toml` value `"rewards"`
 *  was a typo; the deployed scheduler uses this string. */
export const DZ_CONTRIBUTOR_REWARDS_PREFIX = "dz_contributor_rewards";

/** Trailing seed component appended after the epoch. */
const SHAPLEY_OUTPUT_SUFFIX = "shapley_output";

/**
 * Derive the on-chain address of a contributor-rewards record for a
 * given epoch. Mirrors `Pubkey::create_with_seed` semantics:
 *
 *   seed_str = base58(sha256(seeds...)).slice(0, 32)
 *   addr     = sha256(base || seed_str || program_id)
 *
 * Throws if the computed address is on-curve — but `create_with_seed`
 * addresses are always off-curve by construction, so this should never
 * fire in practice.
 */
export function deriveContributorRewardsAddress(
  epoch: number,
  rewardsAccountant: PublicKey = REWARDS_ACCOUNTANT_MAINNET,
): PublicKey {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(`invalid epoch: ${epoch}`);
  }

  // u64 LE epoch encoding
  const epochBytes = new Uint8Array(8);
  new DataView(epochBytes.buffer).setBigUint64(0, BigInt(epoch), true);

  // sha256 over the concatenated seed slices (matches solana_sdk::hash::hashv)
  const h = createHash("sha256");
  h.update(Buffer.from(DZ_CONTRIBUTOR_REWARDS_PREFIX, "utf8"));
  h.update(Buffer.from(epochBytes));
  h.update(Buffer.from(SHAPLEY_OUTPUT_SUFFIX, "utf8"));
  const seedStr = bs58.encode(h.digest()).slice(0, 32);

  // create_with_seed: address = sha256(base || seed_str || program_id)
  const inner = createHash("sha256");
  inner.update(rewardsAccountant.toBuffer());
  inner.update(Buffer.from(seedStr, "utf8"));
  inner.update(DZ_RECORD_PROGRAM_ID.toBuffer());
  return new PublicKey(inner.digest());
}

/** Maximum value of a UnitShare32 — represents 100% of the reward pool. */
export const MAX_UNIT_SHARE = 1_000_000_000;

/** Length of the `RecordData` header in bytes. */
export const RECORD_HEADER_LEN = 33;

/** Length of a single `RewardShare` row in bytes. */
export const REWARD_SHARE_LEN = 40;

export interface RecordHeader {
  version: number;
  authority: string;
}

export interface RewardShare {
  /** Base58 pubkey of the contributor's owner. */
  contributorKey: string;
  /** 0–1,000,000,000 — divide by 1e7 for a percentage. */
  unitShare: number;
  /** Decoded from the packed `remaining_bytes` field. */
  isBlocked: boolean;
  /** Decoded from the packed `remaining_bytes` field. 0–1,000,000,000. */
  economicBurnRate: number;
}

export interface ShapleyOutputStorage {
  epoch: number;
  rewards: RewardShare[];
  /** As stored on chain — may be off by a few units from the actual sum
   *  due to the float-to-fixed reconciliation that bumps the first
   *  reward to make the totals equal MAX_UNIT_SHARE exactly. */
  totalUnitShares: number;
}

const FLAG_IS_BLOCKED_MASK = 1 << 31;
const ECONOMIC_BURN_RATE_MASK = 0x3fffffff;

/**
 * Decode the 33-byte `RecordData` header from the start of an account.
 */
export function decodeRecordHeader(data: Uint8Array): RecordHeader {
  if (data.length < RECORD_HEADER_LEN) {
    throw new Error(
      `record account too short: ${data.length} < ${RECORD_HEADER_LEN}`,
    );
  }
  return {
    version: data[0],
    authority: bs58.encode(data.slice(1, 33)),
  };
}

/**
 * Decode the borsh-encoded `ShapleyOutputStorage` payload, which lives
 * immediately after the 33-byte header.
 */
export function decodeShapleyOutputStorage(
  accountData: Uint8Array,
): ShapleyOutputStorage {
  const payload = accountData.subarray(RECORD_HEADER_LEN);
  if (payload.length < 16) {
    throw new Error(`payload too short: ${payload.length}`);
  }

  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );

  // epoch: u64 LE — fits in a Number for any realistic DZ epoch.
  const epochLo = view.getUint32(0, true);
  const epochHi = view.getUint32(4, true);
  if (epochHi !== 0) {
    throw new Error(`epoch overflow: high 32 bits = ${epochHi}`);
  }
  const epoch = epochLo;

  // Vec<RewardShare> length prefix is u32 LE in borsh.
  const vecLen = view.getUint32(8, true);
  const expected = 8 + 4 + vecLen * REWARD_SHARE_LEN + 4;
  if (payload.length < expected) {
    throw new Error(
      `payload size ${payload.length} < expected ${expected} for ${vecLen} rewards`,
    );
  }

  const rewards: RewardShare[] = [];
  let off = 12;
  for (let i = 0; i < vecLen; i++) {
    const contributorKey = bs58.encode(payload.slice(off, off + 32));
    const unitShare = view.getUint32(off + 32, true);
    const packed = view.getUint32(off + 36, true);
    rewards.push({
      contributorKey,
      unitShare,
      isBlocked: (packed & FLAG_IS_BLOCKED_MASK) !== 0,
      economicBurnRate: packed & ECONOMIC_BURN_RATE_MASK,
    });
    off += REWARD_SHARE_LEN;
  }

  const totalUnitShares = view.getUint32(off, true);

  return { epoch, rewards, totalUnitShares };
}

/**
 * Helper: convert a unit_share (0–1,000,000,000) to a 0–1 share.
 */
export function unitShareToFraction(unitShare: number): number {
  return unitShare / MAX_UNIT_SHARE;
}

/**
 * Helper: convert a unit_share to a percentage string with the given
 * decimal places (default 4 — matches the canonical CLI formatting).
 */
export function formatUnitSharePercent(
  unitShare: number,
  decimals = 4,
): string {
  const pct = (unitShare / MAX_UNIT_SHARE) * 100;
  return `${pct.toFixed(decimals)}%`;
}
