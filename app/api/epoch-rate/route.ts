import { NextResponse } from "next/server";
import { getEpochRate, toPublicEpochRate } from "@/lib/utils/epoch-rate";

export const revalidate = 3600;

const CACHE_CONTROL =
  "public, max-age=3600, s-maxage=3600, stale-while-revalidate=21600";

/**
 * Measured epoch cadence, so a client can turn a per-epoch SOL figure into a
 * monthly and yearly one without a hardcoded constant going stale.
 *
 * Always 200, and the body carries chain facts only. `getEpochRate` reports
 * its own failures server-side and falls back to a real measurement rather
 * than a stale constant, so a degraded read still yields correct figures and
 * there is nothing for a client to act on. `toPublicEpochRate` maps field by
 * field so internal diagnostics cannot reach a caller.
 */
export async function GET() {
  const rate = await getEpochRate();
  return NextResponse.json(toPublicEpochRate(rate), {
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}
