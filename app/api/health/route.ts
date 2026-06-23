import { NextResponse } from "next/server";
import {
  SHAPLEY_SERVICE_URL,
  shapleyEndpointUrl,
} from "@/lib/constants/config";
import { SOLANA_RPC_URL } from "@/lib/onchain/program-ids";
import type { SourceHealth, SourceErrorCode } from "@/lib/types/health";

/**
 * GET /api/health
 *
 * One-shot view of every upstream we depend on. Used by the
 * NetworkPulse and the /status page so operators can see at a
 * glance which source is degraded.
 *
 * The public response intentionally returns only:
 *   - a stable `name` (the upstream identifier)
 *   - a `host` (hostname only — never a path, query, or token)
 *   - the probe `status`, `latencyMs`, `httpStatus`
 *   - a categorized `errorCode` when failing (never raw error text)
 *
 * Full URLs, paths, and auth tokens never leave the server — they
 * stay inside the probe closure. This is a hardening fix for the
 * code review finding H17.
 *
 * The wire shape (`SourceHealth`, `SourceErrorCode`) lives in
 * `lib/types/health.ts` and is shared with the client hook so the
 * two definitions can't drift.
 */

/** Extract just the host from a URL. Returns "(invalid)" for malformed
 *  input — never throws and never echoes the input. */
function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid)";
  }
}

/** Map an unknown error into a coarse category. The raw message is
 *  intentionally discarded — error texts from fetch/AbortSignal often
 *  echo the URL (including credentials). */
function categorize(err: unknown): SourceErrorCode {
  if (err instanceof Error) {
    const name = err.name;
    if (name === "AbortError" || name === "TimeoutError") return "timeout";
    if (name === "TypeError") return "network";
    if (name === "SyntaxError") return "parse";
  }
  return "unknown";
}

async function probe(
  name: string,
  url: string,
  init?: RequestInit,
): Promise<SourceHealth> {
  const host = hostOnly(url);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(8_000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {
        name,
        host,
        status: res.status >= 500 ? "down" : "degraded",
        latencyMs,
        httpStatus: res.status,
      };
    }
    return {
      name,
      host,
      status: latencyMs > 3_000 ? "degraded" : "ok",
      latencyMs,
      httpStatus: res.status,
    };
  } catch (err) {
    return {
      name,
      host,
      status: "down",
      latencyMs: null,
      errorCode: categorize(err),
    };
  }
}

async function probeRpc(name: string, url: string): Promise<SourceHealth> {
  return probe(name, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getHealth",
      params: [],
    }),
  });
}

export async function GET() {
  const probes: Promise<SourceHealth>[] = [
    probe("malbec/topology", "https://data.malbeclabs.com/api/topology"),
    probe("malbec/stats", "https://data.malbeclabs.com/api/stats"),
    probe("malbec/status", "https://data.malbeclabs.com/api/status"),
    probe("dz/economic-hub", "https://doublezero.xyz/api/economic-hub"),
  ];

  if (SHAPLEY_SERVICE_URL) {
    const healthUrl = shapleyEndpointUrl("/health");
    if (healthUrl) {
      probes.push(probe("shapley-service", healthUrl));
    }
  } else {
    probes.push(
      Promise.resolve({
        name: "shapley-service",
        host: "(not configured)",
        status: "disabled",
        latencyMs: null,
      }),
    );
  }

  // Probe the RPC whenever it's configured. ONCHAIN_ENABLED gates whether
  // /api/onchain/* routes return data, but the RPC itself is healthy
  // regardless — showing it as "disabled" when the URL is actually set
  // was misleading.
  if (SOLANA_RPC_URL && SOLANA_RPC_URL.trim()) {
    probes.push(probeRpc("solana-rpc", SOLANA_RPC_URL));
  } else {
    probes.push(
      Promise.resolve({
        name: "solana-rpc",
        host: "(not configured)",
        status: "disabled",
        latencyMs: null,
      }),
    );
  }

  const results = await Promise.all(probes);
  const overall =
    results.some((r) => r.status === "down") ? "down"
    : results.some((r) => r.status === "degraded") ? "degraded"
    : "ok";

  return NextResponse.json(
    {
      overall,
      checkedAt: new Date().toISOString(),
      sources: results,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=15, s-maxage=15, stale-while-revalidate=60",
      },
    },
  );
}
