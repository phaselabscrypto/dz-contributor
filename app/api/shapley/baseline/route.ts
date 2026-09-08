import { NextResponse } from "next/server";
import { shapleyServiceBase } from "@/lib/constants/config";
import { categorizeError, reportError, reportEvent } from "@/lib/observability";
import {
  baselineResponse,
  LATEST_BASELINE_CACHE_CONTROL,
  NO_STORE_HEADERS,
  probeEpochBaseline,
  SERVICE_UNAVAILABLE_BODY,
} from "@/lib/utils/baseline-probe";
import {
  getEpochAvailability,
  READ_ROUTE_DISCOVERY_TIMEOUT_MS,
} from "@/lib/utils/epoch-discovery";
import { enforceRateLimit, RATE_LIMIT_STANDARD } from "@/lib/utils/rate-limit";
import { boundedSignal } from "@/lib/utils/request-deadline";
import { BaselineServiceError } from "@/lib/utils/shapley-remote";

/**
 * GET /api/shapley/baseline
 *
 * The latest completed epoch's Shapley baseline. The route never computes: a
 * hit is the alias the precompute cron published for that epoch, and a miss is
 * `404 {status:"not-cached"}`, which the widgets read as "no card".
 */
// The probe itself is milliseconds. The budget covers a cold epoch-discovery
// HEAD walk, the only slow step left on this path.
export const maxDuration = 30;

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley-baseline",
    ...RATE_LIMIT_STANDARD,
  });
  if (limited) return limited;

  if (!shapleyServiceBase()) {
    reportError(new Error("SHAPLEY_SERVICE_URL not configured"), {
      source: "api/shapley/baseline",
    });
    return NextResponse.json(
      { error: "shapley service not configured" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  let epoch: number;
  try {
    epoch = (
      await getEpochAvailability(false, {
        signal: boundedSignal({}, READ_ROUTE_DISCOVERY_TIMEOUT_MS),
      })
    ).latest;
  } catch (err) {
    reportError(err, {
      source: "api/shapley/baseline",
      extras: { phase: "epoch-discovery" },
    });
    return NextResponse.json(SERVICE_UNAVAILABLE_BODY, {
      status: 502,
      headers: NO_STORE_HEADERS,
    });
  }

  try {
    const probe = await probeEpochBaseline(epoch);
    if (probe.status === "miss") {
      // Sustained events mean the cron or the worker stopped publishing.
      reportEvent("baseline-not-cached", { epoch });
    }
    return baselineResponse(probe, LATEST_BASELINE_CACHE_CONTROL);
  } catch (err) {
    reportError(err instanceof BaselineServiceError ? err : categorizeError(err), {
      source: "api/shapley/baseline",
      extras: { epoch, phase: "probe" },
    });
    return NextResponse.json(SERVICE_UNAVAILABLE_BODY, {
      status: 502,
      headers: NO_STORE_HEADERS,
    });
  }
}
