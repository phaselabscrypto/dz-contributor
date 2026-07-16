import { NextResponse } from "next/server";
import {
  getEpochShapley,
  EpochNotFoundError,
  ShapleyServiceError,
  type EpochShapleyResult,
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
// Cold path = epoch discovery + snapshot fetch + remote call; the upstream
// HAProxy route cuts a cold solve at ~30s, and this function must survive
// past that to translate the failure into 202/502 (Vercel's default
// maxDuration would kill it first and clients would see a raw 504).
export const maxDuration = 60;

/** The 200 body — mirrors EpochShapleyResult plus route provenance fields. */
interface BaselineReady {
  method: string;
  computedAt: string;
  source: "latest-epoch";
  epoch: number;
  operatorCount: number;
  values: EpochShapleyResult["values"];
  inputSummary: EpochShapleyResult["inputSummary"];
}
interface CacheEntry {
  data: BaselineReady;
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
    const result: BaselineReady = {
      method: r.method,
      computedAt: new Date().toISOString(),
      source: "latest-epoch",
      epoch: r.epoch,
      operatorCount: r.operatorCount,
      values: r.values,
      inputSummary: r.inputSummary,
    };
    cached = { data: result, timestamp: Date.now() };
    return NextResponse.json(result);
  } catch (err) {
    // Prefer last-good over any error response.
    if (cached) return NextResponse.json(cached.data);
    if (err instanceof EpochNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ShapleyServiceError && err.warming) {
      // Timeout-class failure: a solve was cut mid-flight, so the epoch
      // exists but isn't cached yet. Healing is owned by the precompute cron
      // (a cut synchronous solve's result is DISCARDED server-side, it does
      // not land in the cache) — so sustained warming means the cron is
      // broken. Report it; this must stay visible, not hide behind 202s.
      reportError(err, {
        source: "api/shapley/baseline",
        extras: { epoch, phase: "warming", status: err.status },
      });
      return NextResponse.json(
        {
          status: "warming",
          message:
            "Baseline warming — result not yet cached for the latest epoch",
          epoch,
        },
        { status: 202 },
      );
    }
    // Everything else is a hard failure: service down/misconfigured, Rust
    // 4xx/5xx, snapshot-fetch errors. 502 per the no-silent-degradation rule
    // (docs/shapley-pipeline.md) — never disguised as warming.
    const phase = err instanceof ShapleyServiceError ? "remote-call" : "outer";
    reportError(err, {
      source: "api/shapley/baseline",
      extras: {
        epoch,
        phase,
        ...(err instanceof ShapleyServiceError ? { status: err.status } : {}),
      },
    });
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 502 },
    );
  }
}
