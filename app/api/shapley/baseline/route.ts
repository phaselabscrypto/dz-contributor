import { NextResponse } from "next/server";
import { SHAPLEY_SERVICE_URL } from "@/lib/constants/config";
import type { ShapleyOutput } from "@/lib/types/shapley";
import { buildLiveShapleyInput } from "@/lib/utils/live-shapley-input";
import { computeShapley as computeShapleyTS } from "@/lib/utils/shapley-solver";
import { computeShapleyRemote } from "@/lib/utils/shapley-remote";
import { enforceRateLimit, RATE_LIMIT_HEAVY } from "@/lib/utils/rate-limit";
import { fetchLiveTopology } from "@/lib/utils/live-topology-fetch";
import { reportError } from "@/lib/observability";

/**
 * GET /api/shapley/baseline
 *
 * Returns Shapley values computed against the CURRENT live topology.
 *
 * When `SHAPLEY_SERVICE_URL` is set, this route ONLY serves canonical
 * results from the Rust solver. If the remote call fails the route
 * returns 502 — we never silently fall back to the local TS heuristic,
 * because that would mask divergence between the two algorithms in
 * production (review note on PR #7).
 *
 * The local TS solver remains available only when `SHAPLEY_SERVICE_URL`
 * is unset entirely (local dev without a Rust service running). In that
 * mode the response method is stamped `local-ts-heuristic-DEV-ONLY` so
 * any downstream consumer can detect the non-canonical path.
 */

interface CacheEntry {
  data: unknown;
  timestamp: number;
}
const CACHE_TTL = 5 * 60 * 1000;
let cached: CacheEntry | null = null;

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, {
    bucket: "shapley-baseline",
    ...RATE_LIMIT_HEAVY,
  });
  if (limited) return limited;


  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  // Direct in-process call — no HTTP self-fetch. Both routes share the
  // same module-level cache via `fetchLiveTopology`, so the caching
  // benefit is preserved without the cold-start deadlock risk.
  let topology;
  try {
    topology = await fetchLiveTopology();
  } catch (err) {
    reportError(err, {
      source: "api/shapley/baseline",
      extras: { phase: "topology-fetch" },
    });
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 502 },
    );
  }
  const input = buildLiveShapleyInput(topology);

  let output;
  let method: string;

  if (SHAPLEY_SERVICE_URL) {
    // Canonical path only. No silent fallback — see file header.
    try {
      const remote = await computeShapleyRemote(input);
      output = remote.output;
      method = remote.method;
    } catch (err) {
      reportError(err, {
        source: "api/shapley/baseline",
        extras: { phase: "remote-call" },
      });
      return NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 502 },
      );
    }
  } else {
    // No remote configured — assumed to be local dev. Loudly stamp the
    // response so any production deployment that hits this branch is
    // immediately spottable in the method label.
    output = computeShapleyTS(input);
    method = "local-ts-heuristic-DEV-ONLY";
  }

  const result = {
    method,
    computedAt: new Date().toISOString(),
    source: "live-topology" as const,
    topologyFetchedAt: new Date(topology.fetchedAt).toISOString(),
    operatorCount: Object.keys(output).length,
    values: output,
    inputSummary: {
      deviceCount: input.devices.length,
      privateLinkCount: input.private_links.length,
      publicLinkCount: input.public_links.length,
      demandCount: input.demands.length,
    },
  };

  cached = { data: result, timestamp: Date.now() };
  return NextResponse.json(result);
}
