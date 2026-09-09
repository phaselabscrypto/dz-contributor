/**
 * DoubleZero on-chain program IDs for the unimplemented registry reader.
 *
 * The ids and discriminators below are unverified. They are NOT the
 * blocker for reading DoubleZero accounts, and nothing here waits on a
 * program IDL. The serviceability program that owns Metro, Device, Link
 * and Contributor accounts is known: see `DZ_SERVICEABILITY_PROGRAM_ID`
 * in `contributor-directory.ts`, which decodes contributor accounts from
 * it using byte offsets verified against every live account.
 *
 * To read the other account types, verify their layouts the same way.
 * See `lib/onchain/README.md`.
 */

/** Set by env so we can test alternate endpoints without code changes. */
export const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

/**
 * Program the unimplemented registry reader would query. Unset, which
 * keeps `topology.ts` dark. The real program id is known: see
 * `DZ_SERVICEABILITY_PROGRAM_ID` in `contributor-directory.ts`.
 */
export const DZ_REGISTRY_PROGRAM_ID = process.env.DZ_REGISTRY_PROGRAM_ID || "";

/** Program that emits per-epoch reward distribution events. */
export const DZ_REWARDS_PROGRAM_ID = process.env.DZ_REWARDS_PROGRAM_ID || "";

/** Whether direct on-chain reads are wired. Toggles A/B routes in the app. */
export const ONCHAIN_ENABLED =
  Boolean(DZ_REGISTRY_PROGRAM_ID) || process.env.ONCHAIN_ENABLED === "1";

/**
 * First-byte account-type discriminators. Every value here is an
 * unverified guess made before any layout was checked on chain, and at
 * least one is wrong: the verified Contributor discriminant is 10, not
 * 0x04 (`contributor-directory.ts`). Verify against a live account
 * before relying on any entry.
 */
export const ACCOUNT_DISCRIMINATORS = {
  metro: 0x01,
  device: 0x02,
  link: 0x03,
  contributor: 0x04,
  epochReward: 0x10,
} as const;

export type ProgramKind = "registry" | "rewards";

/** Resolve a program ID by logical name. Returns empty string when unset. */
export function getProgramId(kind: ProgramKind): string {
  switch (kind) {
    case "registry":
      return DZ_REGISTRY_PROGRAM_ID;
    case "rewards":
      return DZ_REWARDS_PROGRAM_ID;
  }
}
