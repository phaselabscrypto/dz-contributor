import { NextResponse } from "next/server";
import { fetchOnchainTopology, isOnchainReady } from "@/lib/onchain/topology";
import { OnchainNotConfigured } from "@/lib/onchain/decoders";
import { reportError } from "@/lib/observability";

export const revalidate = 60;
export const dynamic = "force-dynamic";

/**
 * Direct on-chain topology read. A/B against `/api/live/topology` (which
 * proxies malbeclabs HTTP). Returns 503 with a stable shape until DZ ships
 * the IDL and we wire the real decoders.
 */
export async function GET() {
  if (!isOnchainReady()) {
    // Deliberately vague: the activation checklist (env-var names etc.)
    // lives in lib/onchain/README.md, not in a public API response.
    return NextResponse.json(
      { ready: false, reason: "On-chain reads are not configured" },
      { status: 503 },
    );
  }
  try {
    const result = await fetchOnchainTopology();
    return NextResponse.json(result.topology, {
      headers: {
        "x-data-source": "onchain",
        "cache-control": "public, max-age=60, stale-while-revalidate=120",
      },
    });
  } catch (err) {
    if (err instanceof OnchainNotConfigured) {
      // Expected disabled state — stable reason, activation details stay
      // in the error message server-side (lib/onchain/decoders.ts).
      return NextResponse.json(
        { ready: false, reason: "On-chain reads are not configured" },
        { status: 503 },
      );
    }
    reportError(err, { source: "api/onchain/topology" });
    return NextResponse.json(
      { ready: false, reason: "On-chain topology fetch failed" },
      { status: 500 },
    );
  }
}
