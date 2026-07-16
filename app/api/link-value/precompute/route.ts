import { NextRequest, NextResponse } from "next/server";
import {
  getSnapshotUrl,
  MIN_DZ_EPOCH,
  SNAPSHOT_FETCH_TIMEOUT_MS,
} from "@/lib/constants/config";
import { bearerMatches } from "@/lib/utils/cron-auth";
import type { RawSnapshot } from "@/lib/types/snapshot";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import { getEpochAvailability } from "@/lib/utils/epoch-discovery";
import {
  JobStartError,
  getSweepStatus,
  startBaselinePrecompute,
  startLinkEstimateSweep,
} from "@/lib/utils/shapley-remote";
import { sweepTag } from "@/lib/utils/sweep-tag";
import { reportError } from "@/lib/observability";

/**
 * GET /api/link-value/precompute — the epoch-cron sweep trigger.
 *
 * Resolves the latest epoch (or `?epoch=N` for manual backfill), checks the
 * service's "fully swept" marker (steady-state fires return in <2s without
 * touching the snapshot), else builds the SAME Shapley input the link-value
 * flow uses (so cache keys align) and enqueues ONE sweep job — the Rust
 * service returns `202 {job_id}` immediately and a worker expands it into
 * per-contributor link-estimate jobs. Results persist to S3, after which every
 * UI request for the epoch is an instant hit. Also warms the epoch's baseline
 * cache (what-if simulator / per-city rewards) as a second queued job.
 *
 * Idempotent: the sweep's expansion skips S3-cached contributors and attaches
 * to in-flight duplicates, so the cron can fire as often as scheduled. The
 * sweep summary is on the job: `GET {service}/jobs/{sweep_job_id}`.
 *
 * Auth (fail-loud): requires `CRON_SECRET` — Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}` on cron invocations when the env var
 * is set. Unset secret → 503 (visible misconfiguration); mismatch → 401.
 */

// The 70MB snapshot fetch + parse + canonical build measured 7–27s locally;
// Vercel's DEFAULT function duration is shorter and would kill the cron
// mid-parse. 300s gives ample headroom (the sweep call itself is a sub-second
// enqueue — the solves run on the service's worker pool, not here).
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured — precompute sweep disabled" },
      { status: 503 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
    epoch = (await getEpochAvailability(false)).latest;
  }

  const tag = sweepTag(epoch);

  // Marker fast-path: a fully-swept epoch needs NO snapshot fetch, parse, or
  // build — the steady-state cron fire is one HEAD-backed status call.
  // Fail-open: a status-check error just means we do the full (idempotent)
  // sweep, which is always safe.
  try {
    const status = await getSweepStatus(tag);
    if (status.complete) {
      console.log(`[link-value/precompute] epoch=${epoch} already swept (marker hit)`);
      return NextResponse.json({ epoch, tag, status: "already-swept" });
    }
  } catch (err) {
    reportError(err, {
      source: "api/link-value/precompute",
      extras: { epoch, phase: "marker-check" },
    });
  }

  try {
    // Shared 120s timeout (see SNAPSHOT_FETCH_TIMEOUT_MS for the measurement
    // rationale). Still well inside maxDuration.
    const snapRes = await fetch(getSnapshotUrl(epoch), {
      signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
    });
    if (!snapRes.ok) {
      return NextResponse.json(
        { error: `Epoch ${epoch} snapshot not found (HTTP ${snapRes.status})` },
        { status: snapRes.status === 404 ? 404 : 502 },
      );
    }
    const raw: RawSnapshot = await snapRes.json();
    // Same canonical input (and therefore same cache keys) as every other
    // link-value path. A snapshot that can't build canonically is a loud 422.
    const built = buildCanonicalShapleyInput(raw);
    if (!built.canonical) {
      return NextResponse.json(
        {
          error: `epoch ${epoch} snapshot cannot build the canonical input: ${built.reason ?? "unknown"}`,
        },
        { status: 422 },
      );
    }

    // Count for the response only — the operator set itself is NOT sent: the
    // service derives the complete set, which is what makes its "fully swept"
    // marker trustworthy (a partial explicit list must never mark the epoch).
    const parsed = parseSnapshot(raw);
    const operators = parsed.contributors
      .filter((c) => c.linkCount > 0)
      .map((c) => c.code);

    const { job_id: sweepJobId } = await startLinkEstimateSweep(
      built.input,
      tag,
    );

    // Also warm the epoch baseline (what-if simulator / per-city rewards) on
    // the same worker pool. Fail-soft: the sweep is already enqueued, so a
    // baseline hiccup is reported, not fatal.
    let baseline: { status: string; job_id?: string } | { error: string };
    try {
      baseline = await startBaselinePrecompute(built.input);
    } catch (err) {
      reportError(err, {
        source: "api/link-value/precompute",
        extras: { epoch, phase: "baseline-warm" },
      });
      baseline = { error: err instanceof Error ? err.message : String(err) };
    }

    console.log(
      `[link-value/precompute] epoch=${epoch} operators=${operators.length} ` +
        `sweep_job_id=${sweepJobId} — poll {service}/jobs/${sweepJobId} for the summary`,
    );
    return NextResponse.json({
      epoch,
      tag,
      operators: operators.length,
      sweep_job_id: sweepJobId,
      baseline,
    });
  } catch (err) {
    reportError(err, { source: "api/link-value/precompute", extras: { epoch } });
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof JobStartError) {
      return NextResponse.json({ error: message }, { status: err.status });
    }
    // Generic on the catch-all 500 — a raw connection error can name the
    // internal service host (the JobStartError branch above is the service's
    // own intended status text, safe to surface).
    return NextResponse.json(
      { error: "precompute sweep failed" },
      { status: 500 },
    );
  }
}
