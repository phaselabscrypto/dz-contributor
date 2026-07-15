import { NextResponse } from "next/server";
import {
  getEpochShapley,
  EpochNotFoundError,
  ShapleyServiceError,
} from "@/lib/utils/epoch-shapley";
import { getEpochAvailability } from "@/lib/utils/epoch-discovery";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { reportError } from "@/lib/observability";

/**
 * GET /api/shapley/baseline
 *
 * The reward "baseline" widgets want: the LATEST completed epoch's
 * Shapley shares (DZ-current methodology). This route resolves the latest
 * available epoch and returns its result from the shared per-epoch
 * cache — the heavy solve runs once (warmed by the precompute cron), never
 * on-demand per request, and never against heuristic live topology.
 *
 * (Previously this ran a full Shapley solve against LIVE Malbec topology on
 * demand, which was expensive, un-warmed, and heuristic — replaced.)
 */
interface CacheEntry {
  data: unknown;
  timestamp: number;
}
const CACHE_TTL = 5 * 60 * 1000;
let cached: CacheEntry | null = null;

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley-baseline",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  let epoch: number;
  try {
    epoch = (await getEpochAvailability()).latest;
  } catch (err) {
    reportError(err, { source: "api/shapley/baseline", extras: { phase: "epoch-discovery" } });
    if (cached) return NextResponse.json(cached.data); // serve last-good rather than 502
    return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 502 });
  }

  try {
    const r = await getEpochShapley(epoch);
    const result = {
      method: r.method,
      computedAt: new Date().toISOString(),
      source: "latest-epoch" as const,
      epoch: r.epoch,
      operatorCount: r.operatorCount,
      values: r.values,
      inputSummary: r.inputSummary,
    };
    cached = { data: result, timestamp: Date.now() };
    return NextResponse.json(result);
  } catch (err) {
    // Cold epoch not yet warmed by the cron: prefer last-good over a 502.
    if (cached) return NextResponse.json(cached.data);
    if (err instanceof EpochNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const phase = err instanceof ShapleyServiceError ? "remote-call" : "outer";
    reportError(err, { source: "api/shapley/baseline", extras: { epoch, phase } });
    // 202: the epoch exists but isn't computed yet (warming) — not a hard outage.
    return NextResponse.json(
      { error: "Baseline warming — result not yet cached for the latest epoch", epoch },
      { status: 202 },
    );
  }
}
