import { NextResponse } from "next/server";
import { getEpochRate } from "@/lib/utils/epoch-rate";

export const revalidate = 3600;

const CACHE_CONTROL =
  "public, max-age=3600, s-maxage=3600, stale-while-revalidate=21600";

/**
 * Measured epoch rate, so the client can turn a per-epoch SOL figure into a
 * monthly and yearly one without a hardcoded constant going stale.
 *
 * Always 200. `getEpochRate` reports its own failures and falls back to the
 * last known-good measurement, so there is no error state to surface: the page
 * needs a number either way, and `source` tells a caller which it got.
 * Caching lives in the module, and the client's own cache means this route is
 * hit about once per viewer per hour.
 */
export async function GET() {
  const rate = await getEpochRate();
  return NextResponse.json(rate, {
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}
