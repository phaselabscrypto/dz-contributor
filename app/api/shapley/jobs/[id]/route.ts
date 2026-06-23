import { NextRequest, NextResponse } from "next/server";
import { SHAPLEY_SERVICE_URL } from "@/lib/constants/config";
import { cancelSimulateJob, getSimulateJob } from "@/lib/utils/shapley-remote";

/**
 * GET /api/shapley/jobs/{id}?contributorCode=...
 *
 * Polls the background job. While running, returns `{ state, progress }`.
 * When done, maps the raw baseline/modified Shapley outputs into the same
 * `{ before, after, delta, allContributors, stats }` shape the synchronous
 * /api/shapley/simulate route returns, so the UI can render it identically.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!SHAPLEY_SERVICE_URL) {
    return NextResponse.json(
      { error: "SHAPLEY_SERVICE_URL not configured" },
      { status: 503 }
    );
  }

  const { id } = await params;
  const contributorCode =
    request.nextUrl.searchParams.get("contributorCode") ?? "";

  try {
    const status = await getSimulateJob(id);

    if (status.state !== "done" || !status.result) {
      return NextResponse.json({
        state: status.state,
        progress: status.progress ?? null,
        error: status.error ?? null,
      });
    }

    const baseline = status.result.baseline.output;
    const modified = status.result.modified.output;
    const beforeShare = baseline[contributorCode]?.share ?? 0;
    const beforeValue = baseline[contributorCode]?.value ?? 0;
    const afterShare = modified[contributorCode]?.share ?? 0;
    const afterValue = modified[contributorCode]?.value ?? 0;

    return NextResponse.json({
      state: "done",
      progress: { percent: 100 },
      before: { share: beforeShare, value: beforeValue },
      after: { share: afterShare, value: afterValue },
      delta: { share: afterShare - beforeShare },
      allContributors: Object.keys({ ...baseline, ...modified }).map(
        (code) => ({
          code,
          beforeShare: baseline[code]?.share ?? 0,
          afterShare: modified[code]?.share ?? 0,
        })
      ),
      stats: status.result.stats,
    });
  } catch (err) {
    // Generic to the client — the error can name the internal service host.
    console.error("GET /api/shapley/jobs/[id] failed:", err);
    return NextResponse.json(
      { error: "Job poll failed" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/shapley/jobs/{id} — request cancellation. `cancelSimulateJob`
 * retries the idempotent service-side cancel; we reflect whether it landed so
 * the client can retry the whole request if it didn't (502).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const cancelled = await cancelSimulateJob(id);
  return NextResponse.json(
    { state: cancelled ? "cancelling" : "cancel-failed" },
    { status: cancelled ? 200 : 502 }
  );
}
