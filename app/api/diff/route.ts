import { NextResponse } from "next/server";
import { shapleyServiceBase } from "@/lib/constants/config";
import {
  DIFF_CACHE_CONTROL,
  validateDiffWindow,
} from "@/lib/utils/diff-window";
import {
  DiffServiceError,
  fetchNetworkDiffRemote,
} from "@/lib/utils/shapley-remote";
import { enforceRateLimit, RATE_LIMIT_STANDARD } from "@/lib/utils/rate-limit";
import { categorizeError, reportError } from "@/lib/observability";

/**
 * GET /api/diff?from=<epoch>&to=<epoch>
 *
 * Proxy over the Rust service's `/diff` endpoint, which serves the
 * per-epoch snapshot diff index. The upstream body is forwarded as bytes;
 * a successful pair is immutable so it is CDN cached.
 */

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, {
    bucket: "diff",
    ...RATE_LIMIT_STANDARD,
  });
  if (limited) return limited;

  const url = new URL(request.url);
  const window = validateDiffWindow(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  );
  if (!window.ok) {
    return NextResponse.json(
      { error: window.error },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const { from, to } = window;

  if (!shapleyServiceBase()) {
    reportError(new Error("SHAPLEY_SERVICE_URL not configured"), {
      source: "api/diff",
    });
    return NextResponse.json(
      { error: "diff service not configured" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const upstream = await fetchNetworkDiffRemote(from, to);
    if (upstream.status === 200) {
      return new NextResponse(upstream.body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": DIFF_CACHE_CONTROL,
        },
      });
    }
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...NO_STORE_HEADERS },
    });
  } catch (err) {
    reportError(err instanceof DiffServiceError ? err : categorizeError(err), {
      source: "api/diff",
      extras: { from, to },
    });
    return NextResponse.json(
      { error: "snapshot fetch failed" },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
