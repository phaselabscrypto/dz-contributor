import { NextResponse } from "next/server";
import {
  getContributorDisplayName,
  shapleyServiceBase,
} from "@/lib/constants/config";
import type { ContributorDiffResponse } from "@/lib/types/diff";
import {
  DIFF_CACHE_CONTROL,
  validateDiffWindow,
} from "@/lib/utils/diff-window";
import {
  DiffServiceError,
  fetchContributorDiffRemote,
} from "@/lib/utils/shapley-remote";
import { enforceRateLimit, RATE_LIMIT_STANDARD } from "@/lib/utils/rate-limit";
import { categorizeError, reportError } from "@/lib/observability";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/** Contributor codes are short on-chain identifiers, e.g. `tsw`, `jump_`. */
const CONTRIBUTOR_CODE = /^[a-z0-9_-]{1,32}$/i;

function isContributorDiffBody(
  value: unknown,
): value is Omit<ContributorDiffResponse, "name"> {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<ContributorDiffResponse>;
  return (
    typeof body.code === "string" &&
    typeof body.from === "number" &&
    typeof body.to === "number" &&
    typeof body.footprint === "object" &&
    body.footprint !== null
  );
}

/**
 * GET /api/diff/contributor/[code]?from=<epoch>&to=<epoch>
 *
 * Proxy over the Rust service's `/diff/contributor/{code}` endpoint. The
 * service has no copy of `CONTRIBUTOR_NAMES`, so the display name is
 * added here before the body is returned.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const limited = enforceRateLimit(request, {
    bucket: "diff-contributor",
    ...RATE_LIMIT_STANDARD,
  });
  if (limited) return limited;

  const { code } = await params;
  if (!code || !CONTRIBUTOR_CODE.test(code)) {
    return NextResponse.json(
      { error: "contributor code required" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

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
      source: "api/diff/contributor",
    });
    return NextResponse.json(
      { error: "diff service not configured" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const upstream = await fetchContributorDiffRemote(code, from, to);
    if (upstream.status !== 200) {
      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": "application/json", ...NO_STORE_HEADERS },
      });
    }
    const parsed: unknown = JSON.parse(upstream.body);
    if (!isContributorDiffBody(parsed)) {
      throw new DiffServiceError("contributor diff body is not the wire shape");
    }
    const data: ContributorDiffResponse = {
      ...parsed,
      name: getContributorDisplayName(code),
    };
    return NextResponse.json(data, {
      headers: { "Cache-Control": DIFF_CACHE_CONTROL },
    });
  } catch (err) {
    reportError(err instanceof DiffServiceError ? err : categorizeError(err), {
      source: "api/diff/contributor",
      extras: { code, from, to },
    });
    return NextResponse.json(
      { error: "snapshot fetch failed" },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
