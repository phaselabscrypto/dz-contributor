/**
 * Thin Solana JSON-RPC client with retry + in-memory cache.
 *
 * ⚠️ Used ONLY by `topology.ts` (scaffolding). The live on-chain paths
 * (`rewards.ts`, `contributor-directory.ts`) use `@solana/web3.js`
 * `Connection` directly. This module exists as a stop-gap so the
 * topology stubs can fetch program accounts without pulling in the
 * full web3.js bundle for code that doesn't execute in production.
 *
 * When the DZ registry IDL lands and `topology.ts` activates, this
 * client will likely be replaced by `@solana/web3.js` Connection too —
 * at that point the bundle-size argument disappears since we're
 * already paying for web3.js elsewhere.
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
  const cacheKey = `${method}:${JSON.stringify(params)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    // Refresh LRU position on hit.
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached.value as T;
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
      cacheSet(cacheKey, body.result, ttl);
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
