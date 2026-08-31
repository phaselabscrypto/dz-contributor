/**
 * Resolve a Solana vote account (or node identity) to its activated stake.
 *
 * The earnings calculator has to answer for any validator on Solana, not only
 * the ones in the DoubleZero publisher feed. `/api/publishers` is built by
 * mapping over the Foundation multicast export, so every row there is a
 * DoubleZero validator by construction and an arbitrary vote account is absent
 * no matter what. This is the second, independent stake source.
 *
 * Filtered lookup first, identity index only on a miss. The filtered response
 * is a few hundred bytes and one round trip; the unfiltered set is one to two
 * megabytes across roughly 1500 entries, so it must never sit on the happy
 * path. The index exists because the RPC filter matches the vote pubkey only,
 * while operators routinely paste a node identity.
 */

import { getVoteAccounts, type VoteAccountInfo } from "./client";
import { categorizeError, reportError } from "@/lib/observability";

/** Trimmed vote-account record. `epochCredits` and `rootSlot` are dropped
 *  because the index holds ~1500 of these and neither is used. */
export interface CompactVoteEntry {
  votePubkey: string;
  nodePubkey: string;
  /** Lamports. */
  activatedStake: number;
  delinquent: boolean;
  epochVoteAccount: boolean;
  commission: number;
  lastVote: number;
}

export type VoteStakeResult =
  | {
      status: "found";
      entry: CompactVoteEntry;
      matchedBy: "vote" | "identity";
    }
  | { status: "not-found" }
  | { status: "unavailable" };

/** Identity index TTL. Activated stake only moves at an epoch boundary, so
 *  five minutes is ample and keeps the expensive call rare. */
const INDEX_TTL_MS = 5 * 60 * 1_000;

const FILTERED_OPTS = { retries: 2, timeoutMs: 4_000 } as const;
const SNAPSHOT_OPTS = { retries: 1, timeoutMs: 10_000 } as const;

function compact(v: VoteAccountInfo, delinquent: boolean): CompactVoteEntry {
  return {
    votePubkey: v.votePubkey,
    nodePubkey: v.nodePubkey,
    activatedStake: v.activatedStake,
    delinquent,
    epochVoteAccount: v.epochVoteAccount,
    commission: v.commission,
    lastVote: v.lastVote,
  };
}

function flatten(res: {
  current: VoteAccountInfo[];
  delinquent: VoteAccountInfo[];
}): CompactVoteEntry[] {
  return [
    ...res.current.map((v) => compact(v, false)),
    ...res.delinquent.map((v) => compact(v, true)),
  ];
}

let index: { byIdentity: Map<string, CompactVoteEntry>; ts: number } | null =
  null;
let indexInFlight: Promise<Map<string, CompactVoteEntry>> | null = null;

/**
 * Pick one entry per identity. An identity can own several vote accounts, so
 * take the largest stake and tie-break on the vote pubkey, which keeps
 * repeated requests answering the same way.
 */
function buildIdentityIndex(
  entries: CompactVoteEntry[],
): Map<string, CompactVoteEntry> {
  const byIdentity = new Map<string, CompactVoteEntry>();
  for (const e of entries) {
    const prev = byIdentity.get(e.nodePubkey);
    if (
      !prev ||
      e.activatedStake > prev.activatedStake ||
      (e.activatedStake === prev.activatedStake &&
        e.votePubkey < prev.votePubkey)
    ) {
      byIdentity.set(e.nodePubkey, e);
    }
  }
  return byIdentity;
}

function cacheIndex(entries: CompactVoteEntry[]): Map<string, CompactVoteEntry> {
  const byIdentity = buildIdentityIndex(entries);
  index = { byIdentity, ts: Date.now() };
  return byIdentity;
}

async function getIdentityIndex(): Promise<Map<string, CompactVoteEntry>> {
  if (index && Date.now() - index.ts < INDEX_TTL_MS) return index.byIdentity;
  // rpc() has no in-flight dedup, which is harmless for a 600-byte payload and
  // wasteful for a multi-megabyte one.
  if (indexInFlight) return indexInFlight;

  indexInFlight = (async () => {
    try {
      // keepUnstakedDelinquents stays false here: true adds thousands of
      // abandoned zero-stake accounts to a payload that exists only to map
      // identity to vote pubkey. The consequence is that an identity whose
      // only vote account is both unstaked and delinquent misses, which the
      // filtered vote-pubkey path handles correctly anyway.
      // ttlMs 0 keeps this out of the shared 64-entry cache.
      const res = await getVoteAccounts({ ttlMs: 0, ...SNAPSHOT_OPTS });
      return cacheIndex(flatten(res));
    } finally {
      indexInFlight = null;
    }
  })();

  return indexInFlight;
}

/**
 * Look up activated stake for a vote account, falling back to a node identity.
 *
 * @param pubkey - a validated base58 pubkey. Validate with
 *   `lib/utils/pubkey.ts` first; this function does not.
 * @returns `found` with the entry and which key matched, `not-found` when the
 *   pubkey is neither a vote account nor a known identity, or `unavailable`
 *   when the chain could not be read. The caller must distinguish the last two:
 *   one is a 404, the other a 502.
 */
export async function resolveVoteAccountStake(
  pubkey: string,
): Promise<VoteStakeResult> {
  try {
    const res = await getVoteAccounts({
      votePubkey: pubkey,
      keepUnstakedDelinquents: true,
      ...FILTERED_OPTS,
    });
    const entries = flatten(res);

    // Some providers have historically ignored the votePubkey filter and
    // returned the whole set, so never trust current[0]: match explicitly.
    // When the filter was ignored the full payload is already in hand, so
    // feed it to the index rather than throwing it away.
    if (entries.length > 1) cacheIndex(entries);

    const hit = entries.find((e) => e.votePubkey === pubkey);
    if (hit) return { status: "found", entry: hit, matchedBy: "vote" };
  } catch (err) {
    // Categorised, not logged verbatim: rpc() builds its HTTP error message
    // from the upstream response body, and SOLANA_RPC_URL can carry a
    // provider API key.
    reportError(new Error(`filtered lookup: ${categorizeError(err)}`), {
      source: "lib/onchain/vote-stake",
    });
    return { status: "unavailable" };
  }

  try {
    const byIdentity = await getIdentityIndex();
    const hit = byIdentity.get(pubkey);
    if (hit) return { status: "found", entry: hit, matchedBy: "identity" };
    return { status: "not-found" };
  } catch (err) {
    reportError(new Error(`identity index: ${categorizeError(err)}`), {
      source: "lib/onchain/vote-stake",
    });
    return { status: "unavailable" };
  }
}

/** Drop the identity index. For tests and forced refresh. */
export function clearVoteStakeCache() {
  index = null;
  indexInFlight = null;
}
