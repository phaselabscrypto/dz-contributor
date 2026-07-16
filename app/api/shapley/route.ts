import { NextRequest, NextResponse } from "next/server";
import {
  getEpochShapley,
  EpochNotFoundError,
  ShapleyServiceError,
} from "@/lib/utils/epoch-shapley";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { reportError } from "@/lib/observability";

// Same cold path as the baseline route (snapshot fetch + remote call) — must
// survive past the upstream ~30s cut to return a typed error, not a raw 504.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const epochStr = searchParams.get("epoch");
  if (!epochStr) {
    return NextResponse.json({ error: "epoch parameter required" }, { status: 400 });
  }
  const epoch = parseInt(epochStr, 10);
  if (isNaN(epoch)) {
    return NextResponse.json({ error: "epoch must be a number" }, { status: 400 });
  }

  try {
    const result = await getEpochShapley(epoch);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof EpochNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ShapleyServiceError) {
      reportError(err, { source: "api/shapley", extras: { epoch, phase: "remote-call" } });
      return NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 502 },
      );
    }
    reportError(err, { source: "api/shapley", extras: { epoch, phase: "outer" } });
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 500 },
    );
  }
}
