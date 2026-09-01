import { NextResponse, type NextRequest } from "next/server";

import { resolveVoteAccountStake } from "@/lib/onchain/vote-stake";
import {
  enforceRateLimit,
  RATE_LIMIT_STANDARD,
} from "@/lib/utils/rate-limit";
import { validatePubkey } from "@/lib/utils/pubkey";
import { LruCache } from "@/lib/utils/lru-cache";
import { LAMPORTS_PER_SOL } from "@/lib/constants/config";
import type {
  StakeWarning,
  ValidatorStakeResponse,
} from "@/lib/types/validator-stake";

export const dynamic = "force-dynamic";
// The two RPC budgets inside resolveVoteAccountStake are 8.25s and 10s worst
// case. Without this the platform default applies and a slow upstream returns
// an HTML 504 instead of our JSON.
export const maxDuration = 15;

/**
 * Activated stake for one vote account.
 *
 * Positive results cache for 60s: stake only moves at an epoch boundary, but
 * `delinquent` and `lastVote` move within minutes and are shown to the user.
 * Misses cache for 5 minutes and are the real defence for the RPC budget —
 * without them a loop over random well-formed pubkeys becomes one upstream
 * call each.
 */
const hitCache = new LruCache<string, ValidatorStakeResponse>({
  ttlMs: 60 * 1_000,
  maxSize: 256,
});
const missCache = new LruCache<string, true>({
  ttlMs: 5 * 60 * 1_000,
  maxSize: 512,
});

const CACHE_CONTROL_OK =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=300";
// 400s and 404s cache at the edge too: that absorbs typo retries and bot
// scans before they reach the function, which protects the RPC budget.
const CACHE_CONTROL_CLIENT_ERROR = "public, max-age=60";

function errorBody(error: string, reason?: string) {
  return { error, ...(reason ? { reason } : {}), hasStake: false, activatedStake: 0 };
}

/**
 * GET /api/validators/stake?pubkey=<base58>
 *
 * Sits outside /api/onchain/* on purpose. That namespace has a documented
 * disabled state gated on DoubleZero program IDs, and this route reads Solana
 * mainnet through a URL that has a working public default, so it has no
 * unconfigured state and never returns 503.
 *
 * Statuses: 400 malformed input, 404 well-formed but not a vote account, 200
 * with `hasStake: false` for a real account holding no stake, 502 when the
 * chain could not be read, 429 when rate limited. Zero stake stays a 200
 * because the account demonstrably exists, and "no stake" and "no such
 * account" have to be distinguishable.
 *
 * No body carries the caller's input, an upstream host, or a dependency's
 * error message.
 */
export async function GET(request: NextRequest) {
  const limited = enforceRateLimit(request, {
    bucket: "validator-stake",
    ...RATE_LIMIT_STANDARD,
  });
  if (limited) return limited;

  const raw = new URL(request.url).searchParams.get("pubkey");
  const validated = validatePubkey(raw);
  if (!validated.ok) {
    return NextResponse.json(
      errorBody(validated.error, validated.reason),
      { status: 400, headers: { "Cache-Control": CACHE_CONTROL_CLIENT_ERROR } },
    );
  }
  const { pubkey } = validated;

  if (missCache.get(pubkey) !== undefined) {
    return NextResponse.json(errorBody("Not a vote account"), {
      status: 404,
      headers: { "Cache-Control": CACHE_CONTROL_CLIENT_ERROR },
    });
  }
  const cached = hitCache.get(pubkey);
  if (cached !== undefined) {
    return NextResponse.json(cached, {
      headers: { "Cache-Control": CACHE_CONTROL_OK },
    });
  }

  const result = await resolveVoteAccountStake(pubkey);

  if (result.status === "unavailable") {
    // Detail already went to reportError inside the resolver, categorised.
    return NextResponse.json(errorBody("Stake lookup failed"), {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (result.status === "not-found") {
    missCache.set(pubkey, true);
    return NextResponse.json(errorBody("Not a vote account"), {
      status: 404,
      headers: { "Cache-Control": CACHE_CONTROL_CLIENT_ERROR },
    });
  }

  const { entry, matchedBy } = result;
  const warnings: StakeWarning[] = [];
  if (entry.delinquent) warnings.push("delinquent");
  if (entry.activatedStake <= 0) warnings.push("zero-stake");
  if (!entry.epochVoteAccount) warnings.push("not-epoch-vote-account");
  if (matchedBy === "identity") warnings.push("identity-match");

  const body: ValidatorStakeResponse = {
    pubkey,
    votePubkey: entry.votePubkey,
    nodePubkey: entry.nodePubkey,
    activatedStake: entry.activatedStake,
    activatedStakeSol: entry.activatedStake / LAMPORTS_PER_SOL,
    hasStake: entry.activatedStake > 0,
    delinquent: entry.delinquent,
    epochVoteAccount: entry.epochVoteAccount,
    commission: entry.commission,
    lastVote: entry.lastVote,
    matchedBy,
    warnings,
    source: "rpc",
  };

  hitCache.set(pubkey, body);
  return NextResponse.json(body, {
    headers: { "Cache-Control": CACHE_CONTROL_OK },
  });
}
