import { NextResponse } from "next/server";
import { MIN_DZ_EPOCH, shapleyServiceBase } from "@/lib/constants/config";
import { categorizeError, reportError } from "@/lib/observability";
import {
  baselineResponse,
  EPOCH_BASELINE_CACHE_CONTROL,
  NO_STORE_HEADERS,
  probeEpochBaseline,
  SERVICE_UNAVAILABLE_BODY,
} from "@/lib/utils/baseline-probe";
import { enforceRateLimit, RATE_LIMIT_STANDARD } from "@/lib/utils/rate-limit";
import { BaselineServiceError } from "@/lib/utils/shapley-remote";

/**
 * GET /api/shapley?epoch=N
 *
 * One epoch's published Shapley baseline, read from the Rust service's epoch
 * alias. Cache-only, exactly like `/api/shapley/baseline`: a miss is
 * `404 {status:"not-cached"}` and nothing here starts a solve.
 */
export const maxDuration = 15;

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley",
    ...RATE_LIMIT_STANDARD,
  });
  if (limited) return limited;

  const epochParam = new URL(request.url).searchParams.get("epoch");
  if (!epochParam) {
    return NextResponse.json(
      { error: "epoch parameter required" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const epoch = Number(epochParam);
  if (!/^\d+$/.test(epochParam) || epoch < MIN_DZ_EPOCH) {
    return NextResponse.json(
      { error: `epoch must be an integer >= ${MIN_DZ_EPOCH}` },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (!shapleyServiceBase()) {
    reportError(new Error("SHAPLEY_SERVICE_URL not configured"), {
      source: "api/shapley",
    });
    return NextResponse.json(
      { error: "shapley service not configured" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const probe = await probeEpochBaseline(epoch);
    return baselineResponse(probe, EPOCH_BASELINE_CACHE_CONTROL);
  } catch (err) {
    reportError(err instanceof BaselineServiceError ? err : categorizeError(err), {
      source: "api/shapley",
      extras: { epoch, phase: "probe" },
    });
    return NextResponse.json(SERVICE_UNAVAILABLE_BODY, {
      status: 502,
      headers: NO_STORE_HEADERS,
    });
  }
}
