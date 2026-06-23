import { NextRequest, NextResponse } from "next/server";
import {
  fetchOnchainEpochReward,
  fetchOnchainRewardHistory,
} from "@/lib/onchain/rewards";
import { LruCache } from "@/lib/utils/lru-cache";

/**
 * GET /api/onchain/rewards
 *
 * Returns per-epoch contributor reward distributions read directly
 * from the DZ ledger (separate Solana cluster from mainnet). The
 * record program ID, rewards accountant key, and seed scheme are all
 * hardcoded constants confirmed against live records.
 *
 * Query params:
 *   epoch=N   — fetch a single epoch's distribution
 *   limit=N   — return only the last N epochs from the history (default: all)
 *
 * Response is cached server-side for 5 minutes. The DZ ledger only
 * gets a new contributor-rewards record once per Solana epoch (every
 * ~2 days), so this is well within freshness.
 */

// Keyed by `${epoch}:${limit}`. Cap at 32; small payloads each.
const cache = new LruCache<string, unknown>({
  ttlMs: 5 * 60 * 1000,
  maxSize: 32,
});

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const epochParam = searchParams.get("epoch");
  const limitParam = searchParams.get("limit");

  const cacheKey = `${epochParam ?? ""}:${limitParam ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return NextResponse.json(cached);
  }

  try {
    if (epochParam) {
      const epoch = parseInt(epochParam, 10);
      if (Number.isNaN(epoch)) {
        return NextResponse.json(
          { error: "epoch must be an integer" },
          { status: 400 },
        );
      }
      const record = await fetchOnchainEpochReward(epoch);
      if (!record) {
        return NextResponse.json(
          { error: `No on-chain record for epoch ${epoch}` },
          { status: 404 },
        );
      }
      cache.set(cacheKey, record);
      return NextResponse.json(record);
    }

    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const history = await fetchOnchainRewardHistory({ limit });
    cache.set(cacheKey, history);
    return NextResponse.json(history);
  } catch (err) {
    return NextResponse.json(
      {
        error: `On-chain reward fetch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        source: "stub",
      },
      { status: 502 },
    );
  }
}
