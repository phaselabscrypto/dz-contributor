import { NextRequest, NextResponse } from "next/server";
import {
  getEpochAvailability,
  READ_ROUTE_DISCOVERY_TIMEOUT_MS,
} from "@/lib/utils/epoch-discovery";
import { reportError } from "@/lib/observability";
import { boundedSignal } from "@/lib/utils/request-deadline";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const withMeta = searchParams.get("withMeta") === "1";

  // Epoch discovery is cheap to refresh and changes ~once per 2 days
  // when a new snapshot lands. 5min CDN cache is plenty.
  const cacheControl =
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600";

  try {
    const result = await getEpochAvailability(withMeta, {
      signal: boundedSignal({}, READ_ROUTE_DISCOVERY_TIMEOUT_MS),
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": cacheControl },
    });
  } catch (err) {
    reportError(err, { source: "api/epochs" });
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 500 },
    );
  }
}
