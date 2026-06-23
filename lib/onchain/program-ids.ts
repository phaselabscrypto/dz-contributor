/**
 * DoubleZero on-chain program IDs.
 *
 * These are placeholders pending DZ's response on Question #6
 * ("Which Solana program(s) and accounts should we read directly?").
 *
 * Once DZ ships an IDL, we drop the program ID + account discriminator
 * here and `decoders.ts` can decode the raw account data.
 *
 * Source-of-truth target: a publicly-published `dz-programs.idl.json`
 * we can pin via git submodule or fetch at build time.
 */

/** Set by env so we can test alternate endpoints without code changes. */
export const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

/** Master program that owns Metro/Device/Link/Contributor accounts. TBD. */
export const DZ_REGISTRY_PROGRAM_ID = process.env.DZ_REGISTRY_PROGRAM_ID || "";

/** Program that emits per-epoch reward distribution events. TBD. */
export const DZ_REWARDS_PROGRAM_ID = process.env.DZ_REWARDS_PROGRAM_ID || "";

/** Whether direct on-chain reads are wired. Toggles A/B routes in the app. */
export const ONCHAIN_ENABLED =
  Boolean(DZ_REGISTRY_PROGRAM_ID) || process.env.ONCHAIN_ENABLED === "1";

/** First-byte discriminators for account types — placeholders. */
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
