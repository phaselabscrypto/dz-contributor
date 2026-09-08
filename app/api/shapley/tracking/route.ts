import { NextResponse } from "next/server";
import { shapleyServiceBase } from "@/lib/constants/config";
import type { EpochBaseline } from "@/lib/types/baseline";
import { categorizeError, reportError } from "@/lib/observability";
import {
  LATEST_BASELINE_CACHE_CONTROL,
  NO_STORE_HEADERS,
  probeEpochBaselines,
  SERVICE_UNAVAILABLE_BODY,
} from "@/lib/utils/baseline-probe";
import {
  getEpochAvailability,
  READ_ROUTE_DISCOVERY_TIMEOUT_MS,
} from "@/lib/utils/epoch-discovery";
import { enforceRateLimit, RATE_LIMIT_STANDARD } from "@/lib/utils/rate-limit";
import { boundedSignal } from "@/lib/utils/request-deadline";
import { BaselineServiceError } from "@/lib/utils/shapley-remote";
import { pivotTracking } from "@/lib/utils/tracking-series";

/**
 * GET /api/shapley/tracking?count=8
 *
 * Per-operator Shapley share trajectories across the PUBLISHED baselines of the
 * latest N epochs. Every epoch is a cache-only probe, so the route never
 * computes; epochs the cron has not published are reported in `missingEpochs`
 * rather than substituted. Fewer than two hits is `404 {status:"not-cached"}`.
 */
export const maxDuration = 30;

const MIN_COUNT = 2;
const MAX_COUNT = 20;
const DEFAULT_COUNT = 8;

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley-tracking",
    ...RATE_LIMIT_STANDARD,
  });
  if (limited) return limited;

  if (!shapleyServiceBase()) {
    reportError(new Error("SHAPLEY_SERVICE_URL not configured"), {
      source: "api/shapley/tracking",
    });
    return NextResponse.json(
      { error: "shapley service not configured" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const url = new URL(request.url);
  const count = Math.max(
    MIN_COUNT,
    Math.min(
      parseInt(url.searchParams.get("count") ?? `${DEFAULT_COUNT}`, 10) ||
        DEFAULT_COUNT,
      MAX_COUNT,
    ),
  );

  let available: number[];
  try {
    const data = await getEpochAvailability(false, {
      signal: boundedSignal({}, READ_ROUTE_DISCOVERY_TIMEOUT_MS),
    });
    available = (data.available ?? []).slice().sort((a, b) => b - a);
  } catch (err) {
    reportError(err, {
      source: "api/shapley/tracking",
      extras: { phase: "epoch-discovery" },
    });
    return NextResponse.json(SERVICE_UNAVAILABLE_BODY, {
      status: 502,
      headers: NO_STORE_HEADERS,
    });
  }

  const targets = available.slice(0, count).sort((a, b) => a - b);
  if (targets.length < MIN_COUNT) {
    return NextResponse.json(
      { error: "Insufficient data" },
      { status: 422, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const probes = await probeEpochBaselines(targets);
    const hits: EpochBaseline[] = [];
    const missingEpochs: number[] = [];
    for (const probe of probes) {
      if (probe.status === "hit") hits.push(probe.body);
      else missingEpochs.push(probe.body.epoch);
    }
    const epochs = hits.map((hit) => hit.epoch);

    if (hits.length < MIN_COUNT) {
      return NextResponse.json(
        { status: "not-cached", epochs, missingEpochs },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    return NextResponse.json(
      {
        epochs,
        missingEpochs,
        ...pivotTracking(hits),
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": LATEST_BASELINE_CACHE_CONTROL } },
    );
  } catch (err) {
    reportError(err instanceof BaselineServiceError ? err : categorizeError(err), {
      source: "api/shapley/tracking",
      extras: { count, phase: "probe" },
    });
    return NextResponse.json(SERVICE_UNAVAILABLE_BODY, {
      status: 502,
      headers: NO_STORE_HEADERS,
    });
  }
}
