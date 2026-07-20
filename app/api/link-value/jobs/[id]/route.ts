import { NextRequest, NextResponse } from "next/server";
import { SHAPLEY_SERVICE_URL } from "@/lib/constants/config";
import {
  cancelSimulateJob,
  getLinkEstimateJob,
} from "@/lib/utils/shapley-remote";

/**
 * GET /api/link-value/jobs/{id}
 *
 * Polls the background link-estimate job. While running, returns
 * `{ state, progress }`. When done, returns
 * `{ state, method, operatorFocus, links }`.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!SHAPLEY_SERVICE_URL) {
    return NextResponse.json(
      { error: "Link-value service is not available" },
      { status: 503 },
    );
  }

  const { id } = await params;

  try {
    const status = await getLinkEstimateJob(id);

    // A "done" job whose result is missing/corrupt is a failure, not a
    // success with no rows.
    if (status.state === "done" && !status.result) {
      return NextResponse.json({
        state: "failed",
        error: "job finished but its result is missing (corrupt or expired)",
      });
    }

    if (status.state !== "done" || !status.result) {
      return NextResponse.json({
        state: status.state,
        progress: status.progress ?? null,
        error: status.error ?? null,
      });
    }

    return NextResponse.json({
      state: "done",
      progress: { percent: 100 },
      method: status.result.method,
      operatorFocus: status.result.operator_focus,
      links: status.result.links,
    });
  } catch (err) {
    // Generic to the client — the error can name the internal service host.
    console.error("GET /api/link-value/jobs/[id] failed:", err);
    return NextResponse.json(
      { error: "Job poll failed" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/link-value/jobs/{id} — request cancellation. The service-side
 * cancel is idempotent and job-id-based (shared across job kinds).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!SHAPLEY_SERVICE_URL) {
    return NextResponse.json(
      { error: "Link-value service is not available" },
      { status: 503 },
    );
  }

  const { id } = await params;
  const cancelled = await cancelSimulateJob(id);
  return NextResponse.json(
    { state: cancelled ? "cancelling" : "cancel-failed" },
    { status: cancelled ? 200 : 502 },
  );
}
