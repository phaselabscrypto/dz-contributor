import { NextRequest, NextResponse } from "next/server";
import {
  getSnapshotUrl,
  MIN_DZ_EPOCH,
  SHAPLEY_SERVICE_URL,
} from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ShapleyInput, ShapleyOutput } from "@/lib/types/shapley";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { buildShapleyInput } from "@/lib/utils/shapley-input-builder";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import { computeShapleyRemote, simulateShapleyRemote } from "@/lib/utils/shapley-remote";
import { modifyShapleyInput } from "@/lib/utils/shapley-input-modifier";
import {
  applyDemandOverrides,
  normalizeDemandOverrides,
} from "@/lib/utils/demand-overrides";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { reportError } from "@/lib/observability";

// Cache baseline computation per epoch — bounded to MAX_CACHE_SIZE entries
const MAX_CACHE_SIZE = 10;
const CACHE_TTL = 30 * 60 * 1000;

const baselineCache = new Map<
  number,
  {
    raw: RawSnapshot;
    input: ShapleyInput;
    /** Whether `input` came from the canonical builder (vs heuristic fallback). */
    canonical: boolean;
    baseline: ShapleyOutput;
    timestamp: number;
  }
>();

function evictStaleCache() {
  const now = Date.now();
  for (const [key, entry] of baselineCache) {
    if (now - entry.timestamp > CACHE_TTL) {
      baselineCache.delete(key);
    }
  }
  if (baselineCache.size > MAX_CACHE_SIZE) {
    const oldest = [...baselineCache.entries()].sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );
    while (baselineCache.size > MAX_CACHE_SIZE && oldest.length > 0) {
      baselineCache.delete(oldest.shift()![0]);
    }
  }
}

export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley-simulate",
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
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
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
      { error: `Epoch ${epoch} is invalid (must be an integer >= ${MIN_DZ_EPOCH})` },
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
  const hasOverrides = Object.keys(overrides).length > 0;

  try {
    evictStaleCache();

    // Get or build baseline input + snapshot
    let cached = baselineCache.get(epoch);
    if (!cached || Date.now() - cached.timestamp > CACHE_TTL) {
      const url = getSnapshotUrl(epoch);
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });

      if (!res.ok) {
        return NextResponse.json(
          { error: `Epoch ${epoch} not found` },
          { status: 404 }
        );
      }

      const raw: RawSnapshot = await res.json();
      const parsed = parseSnapshot(raw);

      // Prefer canonical builder (bit-comparable to DZ Foundation output).
      let input: ShapleyInput;
      const canonical = buildCanonicalShapleyInput(raw);
      if (canonical.canonical) {
        input = canonical.input;
      } else {
        input = buildShapleyInput(raw, parsed);
      }

      const remote = await computeShapleyRemote(input);
      cached = {
        raw,
        input,
        canonical: canonical.canonical,
        baseline: remote.output,
        timestamp: Date.now(),
      };
      baselineCache.set(epoch, cached);
    }

    const { raw, input: baselineInput, baseline } = cached;
    const parsed = parseSnapshot(raw);

    // Demand overrides regenerate the demand table from override-patched
    // city stats (DZ-parity) — only meaningful for canonical snapshots.
    let demandBase = baselineInput;
    if (hasOverrides) {
      if (!cached.canonical) {
        return NextResponse.json(
          {
            error: `demandOverrides require a canonical snapshot; epoch ${epoch} is not`,
          },
          { status: 400 }
        );
      }
      const applied = applyDemandOverrides(raw, baselineInput, overrides);
      if (!applied.ok) {
        return NextResponse.json(
          {
            error: `Unknown metro(s) in demandOverrides: ${applied.unknownMetros.join(
              ", "
            )}. Valid metros: ${applied.knownMetros.join(", ")}`,
          },
          { status: 400 }
        );
      }
      if (applied.input.demands.length === 0) {
        return NextResponse.json(
          { error: "demandOverrides remove all demand rows" },
          { status: 400 }
        );
      }
      demandBase = applied.input;
    }

    // Build modified input
    const modifiedInput = modifyShapleyInput(
      demandBase,
      parsed,
      raw,
      contributorCode,
      safeRemoveLinks,
      safeAddLinks
    );

    // ── Primary: /simulate endpoint (single call, coalition reuse) ────
    let modified: ShapleyOutput;
    try {
      const result = await simulateShapleyRemote(baselineInput, modifiedInput);
      modified = result.modified.output;

      console.log(
        `[shapley/simulate] /simulate: cache_hit=${result.stats.baseline_cache_hit}, ` +
        `reused=${result.stats.coalitions_reused}, solved=${result.stats.coalitions_solved}, ` +
        `baseline_ms=${result.stats.baseline_ms}, modified_ms=${result.stats.modified_ms}`
      );
    } catch (err) {
      // Fallback: separate /shapley call for modified input
      console.warn("[shapley/simulate] /simulate failed, falling back to /shapley:", err);
      const remote = await computeShapleyRemote(modifiedInput);
      modified = remote.output;
    }

    // Guard against an operator-identity mismatch (e.g. output keyed by
    // pubkey while we look up by short code). Without this the lookups below
    // silently resolve to 0 and present a wrong before/after — see no-silent-
    // fallbacks rule (#19).
    if (
      !(contributorCode in baseline) &&
      Object.keys(baseline).length > 0
    ) {
      console.warn(
        `[shapley/simulate] contributorCode "${contributorCode}" absent from ` +
          `Shapley output keys [${Object.keys(baseline).slice(0, 5).join(", ")}…] — ` +
          `before/after will read 0. Operator-identity (code vs pubkey) mismatch?`
      );
    }

    const beforeShare = baseline[contributorCode]?.share ?? 0;
    const beforeValue = baseline[contributorCode]?.value ?? 0;
    const afterShare = modified[contributorCode]?.share ?? 0;
    const afterValue = modified[contributorCode]?.value ?? 0;

    return NextResponse.json({
      epoch,
      contributorCode,
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
    });
  } catch (err) {
    // Full detail is logged server-side; the client gets a generic message —
    // the error can name the internal Shapley service host.
    reportError(err, { source: "api/shapley/simulate", extras: { epoch, contributorCode } });
    return NextResponse.json(
      { error: "Simulation failed" },
      { status: 500 }
    );
  }
}

