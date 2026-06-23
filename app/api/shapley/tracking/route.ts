import { NextResponse } from "next/server";
import { getSnapshotUrl, SHAPLEY_SERVICE_URL } from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ShapleyOutput } from "@/lib/types/shapley";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { buildShapleyInput } from "@/lib/utils/shapley-input-builder";
import { getEpochAvailability } from "@/lib/utils/epoch-discovery";
import { tryComputeShapleyRemote } from "@/lib/utils/shapley-remote";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { reportError } from "@/lib/observability";

/**
 * GET /api/shapley/tracking?count=8
 *
 * Runs the canonical Rust Shapley solver over the latest N completed
 * snapshots and returns per-operator share trajectories. Useful for:
 *   - solver stability: do the same operators score consistently?
 *   - drift detection: have any operators climbed or dropped sharply?
 *   - correctness anchor (until DZ ships per-epoch on-chain payouts)
 *
 * Strict canonical: this route REQUIRES `SHAPLEY_SERVICE_URL`. We don't
 * mix canonical and TS-heuristic results across epochs because the
 * resulting trajectory chart would be a comparison of two different
 * algorithms — exactly the divergence-hiding pattern PR #7 flagged.
 *
 * Per-epoch failures are still surfaced in `skippedEpochs[]` so callers
 * can see WHICH epochs the Rust service couldn't compute, without the
 * route silently swapping algorithms for those slots.
 *
 * Cached for 30 minutes since the inputs are immutable historical snapshots.
 */

import { LruCache } from "@/lib/utils/lru-cache";

// Per-count tracking responses are small (~20KB each). Cap at 4 since
// callers normally request the same `count=8` over and over.
const cache = new LruCache<string, unknown>({
  ttlMs: 30 * 60 * 1000,
  maxSize: 4,
});

interface EpochRun {
  epoch: number;
  method: string;
  values: ShapleyOutput;
}

interface SkippedEpoch {
  epoch: number;
  reason: "snapshot-fetch-failed" | "rust-solver-failed";
}

async function shapleyForEpoch(
  epoch: number,
): Promise<EpochRun | SkippedEpoch> {
  let raw: RawSnapshot;
  try {
    const res = await fetch(getSnapshotUrl(epoch), {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return { epoch, reason: "snapshot-fetch-failed" };
    }
    raw = (await res.json()) as RawSnapshot;
  } catch (err) {
    reportError(err, {
      source: "api/shapley/tracking",
      extras: { epoch, phase: "snapshot-fetch" },
    });
    return { epoch, reason: "snapshot-fetch-failed" };
  }

  const parsed = parseSnapshot(raw);
  const input = buildShapleyInput(raw, parsed);

  const remote = await tryComputeShapleyRemote(input);
  if (!remote) {
    // tryComputeShapleyRemote swallows its own errors — log here so the
    // skip is visible in observability even though we recover.
    reportError(
      new Error(`Rust solver returned no result for epoch ${epoch}`),
      {
        source: "api/shapley/tracking",
        extras: { epoch, phase: "remote-call" },
      },
    );
    return { epoch, reason: "rust-solver-failed" };
  }

  return { epoch, method: remote.method, values: remote.output };
}

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley-tracking",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;
  if (!SHAPLEY_SERVICE_URL) {
    // The tracking endpoint exists to detect drift in the canonical
    // solver — running it against the local TS heuristic is meaningless,
    // so we refuse rather than silently produce non-canonical results.
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const count = Math.max(
    2,
    Math.min(parseInt(url.searchParams.get("count") ?? "8", 10) || 8, 20),
  );

  const cacheKey = `t:${count}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return NextResponse.json(cached);
  }

  // Discover the latest N epochs directly (no HTTP self-call —
  // self-fetching `/api/epochs` from inside another route can deadlock
  // on Vercel cold start if both compete for the same function
  // instance). Same module-level cache applies.
  let available: number[];
  try {
    const data = await getEpochAvailability();
    available = (data.available ?? []).slice().sort((a, b) => b - a);
  } catch (err) {
    reportError(err, {
      source: "api/shapley/tracking",
      extras: { phase: "epoch-discovery" },
    });
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 502 },
    );
  }

  const targetEpochs = available.slice(0, count).reverse();
  if (targetEpochs.length < 2) {
    return NextResponse.json(
      { error: "Insufficient data" },
      { status: 422 },
    );
  }

  // Run sequentially to avoid melting the Rust service / S3.
  const runs: EpochRun[] = [];
  const skipped: SkippedEpoch[] = [];
  for (const ep of targetEpochs) {
    const r = await shapleyForEpoch(ep);
    if ("values" in r) runs.push(r);
    else skipped.push(r);
  }

  if (runs.length < 2) {
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 502 },
    );
  }

  // Pivot to per-operator series
  const allOps = new Set<string>();
  for (const r of runs) for (const op of Object.keys(r.values)) allOps.add(op);

  const operators = [...allOps].map((op) => {
    const series = runs.map((r) => ({
      epoch: r.epoch,
      share: r.values[op]?.share ?? 0,
      value: r.values[op]?.value ?? 0,
    }));
    const last = series[series.length - 1].share;
    const first = series[0].share;
    const stdev = (() => {
      const mean = series.reduce((s, p) => s + p.share, 0) / series.length;
      const v =
        series.reduce((s, p) => s + (p.share - mean) ** 2, 0) / series.length;
      return Math.sqrt(v);
    })();
    return {
      operator: op,
      series,
      latestShare: last,
      delta: last - first,
      stdev,
    };
  });

  operators.sort((a, b) => b.latestShare - a.latestShare);

  const data = {
    epochs: runs.map((r) => r.epoch),
    method: runs[0].method,
    operators,
    skippedEpochs: skipped,
    fetchedAt: new Date().toISOString(),
    note:
      "Canonical Rust-solver share trajectories across the latest N " +
      "completed snapshots. Any epochs the solver couldn't process are " +
      "in `skippedEpochs[]` rather than substituted with a different " +
      "algorithm.",
  };

  cache.set(cacheKey, data);
  return NextResponse.json(data);
}
