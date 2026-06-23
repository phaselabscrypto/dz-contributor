import { NextResponse } from "next/server";
import { fetchOnchainRewardHistory } from "@/lib/onchain/rewards";
import { resolveContributorOwner } from "@/lib/onchain/contributor-directory";
import { LruCache } from "@/lib/utils/lru-cache";

/**
 * GET /api/onchain/contributor-rewards?code=<contributorCode>
 *      /api/onchain/contributor-rewards?key=<ownerPubkey>
 *
 * Per-contributor per-epoch reward history, read live from the DZ ledger.
 * Accepts either:
 *   - `code` — short code (e.g. "infiber"); resolved via the on-chain
 *              contributor directory
 *   - `key`  — owner pubkey (base58)
 */

export const dynamic = "force-dynamic";

// Keyed by owner pubkey. Cap at 32 to comfortably hold every live
// contributor (14 today) plus some headroom.
const cache = new LruCache<string, unknown>({
  ttlMs: 5 * 60 * 1000,
  maxSize: 32,
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const key = searchParams.get("key");

  if (!code && !key) {
    return NextResponse.json(
      { error: "either `code` or `key` parameter required" },
      { status: 400 },
    );
  }

  let ownerKey: string | null = key;
  const resolvedCode: string | null = code;
  if (code && !ownerKey) {
    try {
      ownerKey = await resolveContributorOwner(code);
    } catch (err) {
      return NextResponse.json(
        {
          error: `Failed to resolve contributor directory: ${
            err instanceof Error ? err.message : String(err)
          }`,
          code,
          epochs: [],
        },
        { status: 502 },
      );
    }
    if (!ownerKey) {
      return NextResponse.json(
        { error: `Unknown contributor code: ${code}`, code, epochs: [] },
        { status: 404 },
      );
    }
  }

  const cacheKey = ownerKey ?? "";
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return NextResponse.json(cached, {
      headers: {
        "Cache-Control":
          "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  }

  try {
    const history = await fetchOnchainRewardHistory();
    const epochs = history.epochs
      .map((ep) => {
        const entry = ep.contributors.find(
          (c) => c.contributorKey === ownerKey,
        );
        if (!entry) return null;
        return {
          epoch: ep.epoch,
          unitShare: entry.unitShare,
          share: entry.share,
          isBlocked: entry.isBlocked,
          totalUnitSharesStored: ep.totalUnitSharesStored,
          recordAddress: ep.recordAddress,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const result = {
      code: resolvedCode,
      ownerKey,
      epochs,
      epochCount: epochs.length,
      source: history.source,
      fetchedAt: history.fetchedAt,
    };
    cache.set(cacheKey, result);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control":
          "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        code: resolvedCode,
        ownerKey,
        epochs: [],
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
