import { NextRequest, NextResponse } from "next/server";
import { SHAPLEY_SERVICE_URL, MIN_DZ_EPOCH } from "@/lib/constants/config";
import { getEpochAvailability } from "@/lib/utils/epoch-discovery";
import {
  buildInputForEpoch,
  buildSnapshotInputForEpoch,
  EpochNotFoundError,
} from "@/lib/utils/epoch-input";
import {
  JobStartError,
  startBaselinePrecompute,
} from "@/lib/utils/shapley-remote";
import { bearerMatches } from "@/lib/utils/cron-auth";
import { baselineTag } from "@/lib/utils/sweep-tag";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { reportError } from "@/lib/observability";

/**
 * GET /api/shapley/precompute  (cron)
 *
 * The only thing that starts a baseline solve. Builds the epoch's canonical
 * input and queues the OKD baseline precompute under `baselineTag(epoch)`; the
 * worker publishes that epoch alias once the result is durable. Readers
 * (`/api/shapley/baseline`, `/api/shapley?epoch=N`, `/api/shapley/tracking`)
 * only ever probe the alias. `?epoch=N` for manual backfill.
 *
 * Auth: requires `CRON_SECRET` (Vercel sends `Authorization: Bearer $CRON_SECRET`).
 */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley-precompute",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.log("[shapley/precompute] CRON_SECRET not configured — 503");
    return NextResponse.json(
      { error: "CRON_SECRET not configured — baseline precompute disabled" },
      { status: 503 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    console.log("[shapley/precompute] unauthorized request — 401");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!SHAPLEY_SERVICE_URL) {
    console.log("[shapley/precompute] SHAPLEY_SERVICE_URL not configured — 503");
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
      // it. The latest epoch always builds cleanly; a heuristic result here means
      // the snapshot is too old/incomplete to warm.
      console.log(
        `[shapley/precompute] epoch=${epoch} heuristic-only snapshot — 422, cannot warm`,
      );
      return NextResponse.json(
        { error: `epoch ${epoch} snapshot too old or incomplete — cannot warm baseline`, epoch },
        { status: 422 },
      );
    }
    const tag = baselineTag(epoch);
    const res = await startBaselinePrecompute(input, {
      tag,
      variant:
        inputSource === "canonical-foundation" ? "foundation" : "snapshot",
    });
    console.log(
      `[shapley/precompute] epoch=${epoch} inputSource=${inputSource} ` +
        `tag=${tag} status=${res.status}` +
        (res.job_id ? ` job_id=${res.job_id}` : "") +
        ` input_hash=${res.input_hash}`,
    );

    // The foundation and snapshot-built inputs hash to DIFFERENT service
    // cache keys, and simulate/jobs always build from the snapshot, so when
    // the primary warm was the foundation variant, warm the snapshot variant
    // by hash too. It publishes no alias: one epoch has one published
    // baseline. Fail-soft, since the primary warm is already enqueued.
    let snapshotVariant: Record<string, unknown> | undefined;
    if (inputSource === "canonical-foundation") {
      try {
        const snap = await buildSnapshotInputForEpoch(epoch);
        if (snap.inputSource === "canonical-snapshot") {
          const snapRes = await startBaselinePrecompute(snap.input, null);
          snapshotVariant = { ...snapRes };
          console.log(
            `[shapley/precompute] epoch=${epoch} snapshot-variant ` +
              `status=${snapRes.status}` +
              (snapRes.job_id ? ` job_id=${snapRes.job_id}` : "") +
              ` input_hash=${snapRes.input_hash}`,
          );
        }
      } catch (err) {
        reportError(err, {
          source: "api/shapley/precompute",
          extras: { epoch, phase: "snapshot-variant-warm" },
        });
        snapshotVariant = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return NextResponse.json({
      epoch,
      tag,
      inputSource,
      ...res,
      ...(snapshotVariant ? { snapshotVariant } : {}),
    });
  } catch (err) {
    if (err instanceof EpochNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    reportError(err, { source: "api/shapley/precompute", extras: { epoch, phase: "precompute" } });
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof JobStartError) {
      // Preserve the upstream status — the distinction is load-bearing (the
      // Rust service's 503 means "async jobs disabled", not an internal error).
      return NextResponse.json({ error: message }, { status: err.status });
    }
    return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 502 });
  }
}
