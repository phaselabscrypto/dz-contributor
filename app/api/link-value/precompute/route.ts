import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/utils/cron-auth";
import {
  CRON_WORK_TIMEOUT_MS,
  runPrecomputeIngest,
} from "@/lib/utils/precompute-ingest";

/**
 * GET /api/link-value/precompute: the six-hourly cron. Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}`; the work lives in
 * `runPrecomputeIngest`.
 */

// Vercel's function limit. Work stops at CRON_WORK_TIMEOUT_MS so the response
// is written before it.
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const startedAtMs = Date.now();
  const signal = AbortSignal.timeout(CRON_WORK_TIMEOUT_MS);
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runPrecomputeIngest(
    request.nextUrl.searchParams.get("epoch"),
    { startedAtMs, signal },
  );
  return NextResponse.json(result.body, { status: result.status });
}
