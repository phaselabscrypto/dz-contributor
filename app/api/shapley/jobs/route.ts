import { NextRequest, NextResponse } from "next/server";
import { MIN_DZ_EPOCH, SHAPLEY_SERVICE_URL } from "@/lib/constants/config";
import { reportError } from "@/lib/observability";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import {
  EpochSnapshotError,
  fetchEpochSnapshot,
  snapshotFailure,
} from "@/lib/utils/epoch-snapshot";
import { startSimulateJob } from "@/lib/utils/shapley-remote";
import { modifyShapleyInput } from "@/lib/utils/shapley-input-modifier";
import {
  buildOverriddenInput,
  normalizeDemandOverrides,
} from "@/lib/utils/demand-overrides";
import {
  normalizeLinkEdits,
  validateLinkEditsAgainstSnapshot,
} from "@/lib/utils/link-edits";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";

/**
 * POST /api/shapley/jobs — start an async what-if simulation.
 *
 * Builds the baseline + modified Shapley inputs (snapshot → canonical builder
 * → modifier), kicks off a background job on the Rust service, and
 * returns `{ jobId }` immediately (202). The browser then polls
 * `GET /api/shapley/jobs/{id}` for progress + result and can `DELETE` to cancel.
 */

// Snapshot fetch + parse + canonical build measured ~7–15s locally; Vercel's
// default function duration would kill submits mid-parse.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley-jobs",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;

  if (!SHAPLEY_SERVICE_URL) {
    return NextResponse.json(
      // Config-state 503: generic to the client (the env-var name is
      // internal); /api/health shows shapley-service: disabled for ops.
      { error: "Simulation service is not available" },
      { status: 503 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { epoch, contributorCode, removeLinks, addLinks, demandOverrides } =
    body;

  if (
    typeof epoch !== "number" ||
    typeof contributorCode !== "string" ||
    !contributorCode
  ) {
    return NextResponse.json(
      { error: "epoch (number) and contributorCode (string) required" },
      { status: 400 }
    );
  }
  if (!Number.isInteger(epoch) || epoch < MIN_DZ_EPOCH) {
    return NextResponse.json(
      {
        error: `Epoch ${epoch} is invalid (must be an integer >= ${MIN_DZ_EPOCH})`,
      },
      { status: 400 }
    );
  }

  const linkEdits = normalizeLinkEdits(addLinks, removeLinks);
  if (!linkEdits.ok) {
    return NextResponse.json({ error: linkEdits.error }, { status: 400 });
  }
  const normalized = normalizeDemandOverrides(demandOverrides);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }
  const overrides = normalized.overrides;

  try {
    const raw = await fetchEpochSnapshot(epoch, { timeoutMs: 30_000 });
    const parsed = parseSnapshot(raw);

    // The canonical builder is the only input source. A snapshot it cannot
    // use is a 422, never a heuristic substitute.
    const built = buildCanonicalShapleyInput(raw);
    if (!built.canonical) {
      return NextResponse.json(
        {
          error: `Epoch ${epoch} snapshot cannot build the canonical input: ${built.reason ?? "unknown"}`,
        },
        { status: 422 }
      );
    }
    const baselineInput = built.input;

    // Demand overrides regenerate the demand table from override-patched
    // city stats (DZ-parity).
    const overridden = buildOverriddenInput({
      snap: raw,
      baselineInput,
      overrides,
      epoch,
      canonical: true,
    });
    if (!overridden.ok) {
      return NextResponse.json({ error: overridden.error }, { status: 400 });
    }

    const linkCheck = validateLinkEditsAgainstSnapshot({
      raw,
      parsed,
      contributorCode,
      addLinks: linkEdits.addLinks,
      removeLinks: linkEdits.removeLinks,
    });
    if (!linkCheck.ok) {
      return NextResponse.json({ error: linkCheck.error }, { status: 400 });
    }

    const modifiedInput = modifyShapleyInput(
      overridden.input,
      parsed,
      raw,
      contributorCode,
      linkEdits.removeLinks,
      linkEdits.addLinks
    );

    const jobId = await startSimulateJob(baselineInput, modifiedInput);
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
    if (err instanceof EpochSnapshotError) {
      const failure = snapshotFailure(err);
      if (failure.status !== 404) {
        reportError(err, {
          source: "api/shapley/jobs",
          extras: { epoch, contributorCode, phase: "snapshot" },
        });
      }
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    // Log the full reason server-side (incl. `.cause`, which carries the
    // ECONNREFUSED/ENOTFOUND + host:port) — but never echo it to the client:
    // this route calls the internal Shapley service and the error can name its
    // (private) host.
    reportError(err, {
      source: "api/shapley/jobs",
      extras: { epoch, contributorCode, phase: "start" },
    });
    return NextResponse.json(
      { error: "Failed to start simulation" },
      { status: 500 }
    );
  }
}
