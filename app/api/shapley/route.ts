import { NextRequest, NextResponse } from "next/server";
import { getSnapshotUrl, SHAPLEY_SERVICE_URL } from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ShapleyInput, ShapleyOutput } from "@/lib/types/shapley";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { buildShapleyInput } from "@/lib/utils/shapley-input-builder";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import { computeShapley as computeShapleyTS } from "@/lib/utils/shapley-solver";
import { computeShapleyRemote } from "@/lib/utils/shapley-remote";
import {
  fetchCanonicalInput,
  isCanonicalEnabled,
} from "@/lib/utils/canonical-inputs";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { reportError } from "@/lib/observability";
import { LruCache } from "@/lib/utils/lru-cache";

// Shapley outputs are small (operator → {value, share} dictionaries) so
// the size cap is generous. TTL stays at 30min since inputs are
// historical snapshots — they never change.
const shapleyCache = new LruCache<number, unknown>({
  ttlMs: 30 * 60 * 1000,
  maxSize: 32,
});

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

  const cached = shapleyCache.get(epoch);
  if (cached !== undefined) {
    return NextResponse.json(cached);
  }

  try {
    // Input source priority (highest to lowest):
    //   1. canonical-foundation — fetched from DZ_CANONICAL_INPUTS_URL (if set)
    //   2. canonical-snapshot   — built locally by the canonical TS port,
    //                             verified bit-comparable to the Foundation
    //                             Python reference on epoch 149
    //   3. snapshot-heuristic   — heuristic builder (only used when the
    //                             snapshot lacks start_us/metro_prices)
    let input: ShapleyInput | null = null;
    let inputSource:
      | "canonical-foundation"
      | "canonical-snapshot"
      | "snapshot-heuristic" = "snapshot-heuristic";
    let canonicalFallbackReason: string | undefined;

    if (isCanonicalEnabled) {
      const canonical = await fetchCanonicalInput(epoch);
      if (canonical) {
        input = canonical;
        inputSource = "canonical-foundation";
      }
    }

    let raw: RawSnapshot | null = null;
    if (!input) {
      const url = getSnapshotUrl(epoch);
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        return NextResponse.json(
          { error: `Epoch ${epoch} not found` },
          { status: res.status === 404 ? 404 : 500 },
        );
      }
      raw = (await res.json()) as RawSnapshot;

      // Try the canonical TS builder first. Falls back to heuristic if the
      // snapshot doesn't carry the canonical fields (start_us, metro_prices).
      const canonical = buildCanonicalShapleyInput(raw);
      if (canonical.canonical) {
        input = canonical.input;
        inputSource = "canonical-snapshot";
      } else {
        canonicalFallbackReason = canonical.reason;
        const parsed = parseSnapshot(raw);
        input = buildShapleyInput(raw, parsed);
        inputSource = "snapshot-heuristic";
      }
    }

    // Canonical solver only when SHAPLEY_SERVICE_URL is configured.
    // No silent fallback — if the Rust service fails we surface 502 so
    // ops sees the outage instead of silently swapping algorithms in
    // production (PR #7 review).
    let output: ShapleyOutput;
    let method: string;

    if (SHAPLEY_SERVICE_URL) {
      try {
        const remote = await computeShapleyRemote(input);
        output = remote.output;
        method = remote.method;
      } catch (err) {
        reportError(err, {
          source: "api/shapley",
          extras: { epoch, phase: "remote-call" },
        });
        return NextResponse.json(
          { error: "Service temporarily unavailable" },
          { status: 502 },
        );
      }
    } else {
      // Dev-only path. Method label flags non-canonical results loudly.
      output = computeShapleyTS(input);
      method = "local-ts-heuristic-DEV-ONLY";
    }

    const result = {
      epoch,
      method,
      inputSource,
      inputFallbackReason: canonicalFallbackReason,
      operatorCount: Object.keys(output).length,
      values: output,
      inputSummary: {
        deviceCount: input.devices.length,
        privateLinkCount: input.private_links.length,
        publicLinkCount: input.public_links.length,
        demandCount: input.demands.length,
      },
    };

    shapleyCache.set(epoch, result);
    return NextResponse.json(result);
  } catch (err) {
    reportError(err, {
      source: "api/shapley",
      extras: { epoch, phase: "outer" },
    });
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 500 },
    );
  }
}
