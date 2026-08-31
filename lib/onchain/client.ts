/**
 * Thin Solana JSON-RPC client with retry + in-memory cache.
 *
 * Live in production. `getSlot`, `getBlockTime` and `getEpochInfo` back the
 * measured epoch rate in `lib/utils/epoch-rate.ts`, which feeds every monthly
 * and yearly SOL projection in the app. `getProgramAccounts` and
 * `getAccountInfo` are still only used by `topology.ts` (scaffolding); the
 * live on-chain reward paths (`rewards.ts`, `contributor-directory.ts`) use
 * `@solana/web3.js` `Connection` directly.
 *
 * Raw JSON-RPC rather than `Connection` is a requirement, not a preference:
 * web3.js 1.98.4 declares `getVoteAccounts(commitment?)` with no `votePubkey`
 * filter and no `keepUnstakedDelinquents` flag, so it cannot express the
 * single-validator query. `rpc()` passes an arbitrary config object.
 *
 * See `lib/onchain/README.md` for the live-vs-stub matrix.
 */

import { SOLANA_RPC_URL } from "./program-ids";

interface JsonRpcOk<T> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}
interface JsonRpcErr {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string };
}
type JsonRpcResp<T> = JsonRpcOk<T> | JsonRpcErr;

interface CacheEntry<T> {
  value: T;
  expires: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const DEFAULT_TTL_MS = 60 * 1000;
// LRU cap: RPC payloads vary in size; 64 entries covers all live
// callers (8 program accounts × ~5 methods + some headroom) without
// blowing past Vercel's Lambda memory budget.
const MAX_CACHE_SIZE = 64;
let nextId = 1;

function cacheSet<T>(key: string, value: T, ttlMs: number) {
  // Re-insert at the tail for LRU semantics.
  cache.delete(key);
  cache.set(key, { value, expires: Date.now() + ttlMs });
  while (cache.size > MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function rpc<T>(
  method: string,
  params: unknown[],
  opts: { ttlMs?: number; retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // ttl <= 0 bypasses the cache in both directions. The map is capped at 64
  // entries sized for a fixed set of callers, so a large or caller-keyed
  // payload must be able to stay out of it rather than evict the rest.
  const useCache = ttl > 0;
  const cacheKey = `${method}:${JSON.stringify(params)}`;
  if (useCache) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      // Refresh LRU position on hit.
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached.value as T;
    }
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(SOLANA_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method,
          params,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`RPC HTTP ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as JsonRpcResp<T>;
      if ("error" in body) {
        throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
      }
      if (useCache) cacheSet(cacheKey, body.result, ttl);
      return body.result;
    } catch (err) {
      lastErr = err;
      // Exponential backoff between attempts.
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface AccountInfoBase64 {
  data: [string, "base64"];
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
}

export interface ProgramAccountEntry {
  pubkey: string;
  account: AccountInfoBase64;
}

export async function getProgramAccounts(
  programId: string,
  filters?: Array<
    { dataSize: number } | { memcmp: { offset: number; bytes: string } }
  >,
): Promise<ProgramAccountEntry[]> {
  if (!programId) return [];
  return rpc<ProgramAccountEntry[]>(
    "getProgramAccounts",
    [
      programId,
      {
        encoding: "base64",
        ...(filters ? { filters } : {}),
        commitment: "confirmed",
      },
    ],
    { ttlMs: 60_000 },
  );
}

export async function getAccountInfo(
  pubkey: string,
): Promise<AccountInfoBase64 | null> {
  const result = await rpc<{ value: AccountInfoBase64 | null }>(
    "getAccountInfo",
    [pubkey, { encoding: "base64", commitment: "confirmed" }],
    { ttlMs: 60_000 },
  );
  return result.value;
}

export interface VoteAccountInfo {
  votePubkey: string;
  nodePubkey: string;
  /** Lamports. Stays a `number` to match Publisher.activated_stake; the
   *  precision loss above 2^53 lamports is ~1e-14 relative, eleven orders of
   *  magnitude below anything displayed. */
  activatedStake: number;
  /** False when the account holds no stake at the epoch boundary. */
  epochVoteAccount: boolean;
  commission: number;
  lastVote: number;
  rootSlot: number;
  /** [epoch, credits, previousCredits] triples, oldest first. */
  epochCredits: Array<[number, number, number]>;
}

export interface VoteAccountsResponse {
  current: VoteAccountInfo[];
  delinquent: VoteAccountInfo[];
}

export interface GetVoteAccountsOpts {
  /**
   * Restrict the result to one vote account. Cuts the response from megabytes
   * to a few hundred bytes. Matches the VOTE pubkey only, never the node
   * identity.
   */
  votePubkey?: string;
  /**
   * Keep delinquent vote accounts that hold no stake.
   *
   * REQUIRED when probing a single key. At the RPC default of false, an
   * unstaked delinquent account is absent from both arrays, so its response is
   * byte-identical to that of a pubkey which is not a vote account at all.
   * That collapses "exists with no stake" into "does not exist", and those
   * have to be distinguishable.
   */
  keepUnstakedDelinquents?: boolean;
  /** Pass 0 to bypass the module cache. */
  ttlMs?: number;
  retries?: number;
  timeoutMs?: number;
}

/**
 * Vote accounts, optionally filtered to one.
 *
 * Raw JSON-RPC because `@solana/web3.js` 1.98.4 declares
 * `getVoteAccounts(commitment?)` and exposes neither config field, so it
 * cannot express a single-validator query and would pull the whole cluster on
 * every lookup.
 */
export async function getVoteAccounts(
  opts: GetVoteAccountsOpts = {},
): Promise<VoteAccountsResponse> {
  const { votePubkey, keepUnstakedDelinquents, ttlMs, retries, timeoutMs } =
    opts;
  return rpc<VoteAccountsResponse>(
    "getVoteAccounts",
    [
      {
        commitment: "confirmed",
        // Conditional spreads, not `votePubkey: undefined`: the cache key is
        // JSON.stringify(params), and an explicit undefined serialises
        // differently from an omitted field, splitting one logical entry.
        ...(votePubkey ? { votePubkey } : {}),
        ...(keepUnstakedDelinquents !== undefined
          ? { keepUnstakedDelinquents }
          : {}),
      },
    ],
    { ttlMs: ttlMs ?? DEFAULT_TTL_MS, retries, timeoutMs },
  );
}

/** Latest slot the node considers final. */
export async function getSlot(): Promise<number> {
  return rpc<number>("getSlot", [{ commitment: "finalized" }], {
    ttlMs: 30_000,
  });
}

/**
 * Unix timestamp of a slot, in whole seconds, or null when the node has no
 * block for it. The one-second resolution is why callers must sample across a
 * wide slot window rather than differencing adjacent slots.
 */
export async function getBlockTime(slot: number): Promise<number | null> {
  return rpc<number | null>("getBlockTime", [slot], { ttlMs: 6 * 60 * 60_000 });
}

export async function getEpochInfo(): Promise<{
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
  blockHeight: number;
}> {
  return rpc("getEpochInfo", [], { ttlMs: 30_000 });
}

/** Reset the in-memory cache. Useful for tests and forced refresh. */
export function clearOnchainCache() {
  cache.clear();
}
