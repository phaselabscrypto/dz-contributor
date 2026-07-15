import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { SHAPLEY_SERVICE_URL, MIN_DZ_EPOCH } from "@/lib/constants/config";
import { getEpochAvailability } from "@/lib/utils/epoch-discovery";
import { buildInputForEpoch, EpochNotFoundError } from "@/lib/utils/canonical-epoch";
import { startBaselinePrecompute } from "@/lib/utils/shapley-remote";
import { reportError } from "@/lib/observability";

/**
 * GET /api/shapley/precompute  (cron)
 *
 * Warms the canonical baseline for the latest epoch so `/api/shapley/baseline`
 * (and `/api/shapley?epoch=latest`) serve a cache hit instead of triggering a
 * cold per-city solve inside a user request. Builds the SAME canonical input
 * those routes build, then QUEUES the OKD baseline precompute (async worker);
 * the result lands in the input-hash cache. `?epoch=N` for manual backfill.
 *
 * Auth: requires `CRON_SECRET` (Vercel sends `Authorization: Bearer $CRON_SECRET`).
 */
export const maxDuration = 300;

function bearerMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(header);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured — baseline precompute disabled" },
      { status: 503 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!SHAPLEY_SERVICE_URL) {
    return NextResponse.json(
      { error: "SHAPLEY_SERVICE_URL not configured — nothing to precompute" },
      { status: 503 },
    );
  }

  let epoch: number;
  const epochParam = request.nextUrl.searchParams.get("epoch");
  if (epochParam !== null) {
    epoch = Number(epochParam);
    if (!Number.isInteger(epoch) || epoch < MIN_DZ_EPOCH) {
      return NextResponse.json(
        { error: `epoch ${epochParam} invalid (integer >= ${MIN_DZ_EPOCH})` },
        { status: 400 },
      );
    }
  } else {
    try {
      epoch = (await getEpochAvailability(false)).latest;
    } catch (err) {
      reportError(err, { source: "api/shapley/precompute", extras: { phase: "epoch-discovery" } });
      return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 502 });
    }
  }

  try {
    const { input, inputSource } = await buildInputForEpoch(epoch);
    if (inputSource === "snapshot-heuristic") {
      // Heuristic input lacks city_weights → the per-city reward path can't run
      // it. The latest epoch is always canonical; a heuristic result here means
      // the snapshot is too old/incomplete to warm.
      return NextResponse.json(
        { error: `epoch ${epoch} snapshot not canonical — cannot warm baseline`, epoch },
        { status: 422 },
      );
    }
    const res = await startBaselinePrecompute(input);
    return NextResponse.json({ epoch, inputSource, ...res });
  } catch (err) {
    if (err instanceof EpochNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    reportError(err, { source: "api/shapley/precompute", extras: { epoch, phase: "precompute" } });
    return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 502 });
  }
}
