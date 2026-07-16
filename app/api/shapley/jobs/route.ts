import { NextRequest, NextResponse } from "next/server";
import {
  getSnapshotUrl,
  MIN_DZ_EPOCH,
  SHAPLEY_SERVICE_URL,
  SNAPSHOT_FETCH_TIMEOUT_MS,
} from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ShapleyInput } from "@/lib/types/shapley";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { buildShapleyInput } from "@/lib/utils/shapley-input-builder";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import { startSimulateJob } from "@/lib/utils/shapley-remote";
import { modifyShapleyInput } from "@/lib/utils/shapley-input-modifier";
import {
  buildOverriddenInput,
  normalizeDemandOverrides,
} from "@/lib/utils/demand-overrides";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";

/**
 * POST /api/shapley/jobs — start an async what-if simulation.
 *
 * Builds the baseline + modified Shapley inputs (snapshot → canonical/heuristic
 * builder → modifier), kicks off a background job on the Rust service, and
 * returns `{ jobId }` immediately (202). The browser then polls
 * `GET /api/shapley/jobs/{id}` for progress + result and can `DELETE` to cancel.
 */
export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley-jobs",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;

  if (!SHAPLEY_SERVICE_URL) {
    return NextResponse.json(
      { error: "SHAPLEY_SERVICE_URL not configured" },
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

  const safeRemoveLinks = Array.isArray(removeLinks) ? removeLinks : [];
  const safeAddLinks = Array.isArray(addLinks) ? addLinks : [];
  const normalized = normalizeDemandOverrides(demandOverrides);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }
  const overrides = normalized.overrides;

  try {
    const url = getSnapshotUrl(epoch);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Epoch ${epoch} not found` },
        { status: 404 }
      );
    }

    const raw: RawSnapshot = await res.json();
    const parsed = parseSnapshot(raw);

    let baselineInput: ShapleyInput;
    const canonical = buildCanonicalShapleyInput(raw);
    if (canonical.canonical) {
      baselineInput = canonical.input;
    } else {
      baselineInput = buildShapleyInput(raw, parsed);
    }

    // Demand overrides regenerate the demand table from override-patched
    // city stats (DZ-parity) — only meaningful for canonical snapshots.
    const overridden = buildOverriddenInput({
      snap: raw,
      baselineInput,
      overrides,
      epoch,
      canonical: canonical.canonical,
      canonicalReason: canonical.reason,
    });
    if (!overridden.ok) {
      return NextResponse.json({ error: overridden.error }, { status: 400 });
    }

    const modifiedInput = modifyShapleyInput(
      overridden.input,
      parsed,
      raw,
      contributorCode,
      safeRemoveLinks,
      safeAddLinks
    );

    const jobId = await startSimulateJob(baselineInput, modifiedInput);
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
    // Log the full reason server-side (incl. `.cause`, which carries the
    // ECONNREFUSED/ENOTFOUND + host:port) — but never echo it to the client:
    // this route calls the internal Shapley service and the error can name its
    // (private) host.
    console.error("POST /api/shapley/jobs failed:", err);
    return NextResponse.json(
      { error: "Failed to start simulation" },
      { status: 500 }
    );
  }
}
