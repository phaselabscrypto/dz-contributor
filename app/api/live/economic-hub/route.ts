import { NextResponse } from "next/server";
import { fetchEconomicHub } from "@/lib/utils/economic-hub-fetch";
import type { EconomicHub, EconomicHubContributor } from "@/lib/types/live";
import { reportError } from "@/lib/observability";


export const revalidate = 300;

let cache: { data: EconomicHub; ts: number } | null = null;
const TTL_MS = 5 * 60_000;

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) {
    return NextResponse.json(cache.data, {
      headers: {
        "Cache-Control":
          "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  }
  try {
    const data = await fetchEconomicHub();
    cache = { data, ts: now };
    return NextResponse.json(data, {
      headers: {
        "Cache-Control":
          "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    reportError(err, { source: "api/live/economic-hub" });
    // Generic to the client — the message can name the upstream host.
    return NextResponse.json(
      { error: "Economic-hub fetch failed" },
      { status: 502 },
    );
  }
}
