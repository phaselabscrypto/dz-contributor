import { NextRequest, NextResponse } from "next/server";
import {
  getSnapshotUrl,
  MIN_DZ_EPOCH,
  SHAPLEY_SERVICE_URL,
} from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import { JobStartError, startLinkEstimateJob } from "@/lib/utils/shapley-remote";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { reportError } from "@/lib/observability";

/**
 * POST /api/link-value/jobs — start an async per-link value-add job.
 *
 * Builds the canonical Shapley input from the epoch snapshot, kicks off a
 * background `network_link_estimate` job on the Rust service, and returns
 * `{ jobId }` (202). The browser polls `GET /api/link-value/jobs/{id}` for
 * progress + result and `DELETE`s to cancel.
 *
 * Returns 503 when async jobs are unavailable (no SHAPLEY_SERVICE_URL) —
 * surfaced to the page as a hard error.
 */

// Snapshot fetch + parse + canonical build measured ~7–15s locally; Vercel's
// default function duration would kill submits mid-parse.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, {
    bucket: "link-value",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { epoch, contributorCode } = body as {
    epoch?: number;
    contributorCode?: string;
  };

  if (typeof epoch !== "number" || typeof contributorCode !== "string") {
    return NextResponse.json(
      { error: "epoch (number) and contributorCode (string) required" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(epoch) || epoch < MIN_DZ_EPOCH) {
    return NextResponse.json(
      { error: `Epoch ${epoch} is invalid (must be an integer >= ${MIN_DZ_EPOCH})` },
      { status: 400 },
    );
  }

  if (!SHAPLEY_SERVICE_URL) {
    return NextResponse.json(
      { error: "SHAPLEY_SERVICE_URL not configured — canonical link values unavailable." },
      { status: 503 },
    );
  }

  try {
    const snapRes = await fetch(getSnapshotUrl(epoch), {
      signal: AbortSignal.timeout(30_000),
    });
    if (!snapRes.ok) {
      return NextResponse.json(
        { error: `Epoch ${epoch} not found` },
        { status: snapRes.status === 404 ? 404 : 500 },
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

    const jobId = await startLinkEstimateJob(built.input, contributorCode);
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
    reportError(err, {
      source: "api/link-value/jobs",
      extras: { epoch, contributorCode },
    });
    const message = err instanceof Error ? err.message : String(err);
    // Propagate the upstream status instead of collapsing to 500: the Rust
    // 503 ("async jobs disabled") and 422 (player cap / validation) are
    // distinct, actionable failures and must stay distinguishable.
    if (err instanceof JobStartError) {
      return NextResponse.json({ error: message }, { status: err.status });
    }
    // Generic on the catch-all 500 — a raw connection error can name the
    // internal service host (the JobStartError branch above carries the
    // service's own intended status text, which is safe to surface).
    return NextResponse.json(
      { error: "Failed to start link-estimate" },
      { status: 500 },
    );
  }
}
