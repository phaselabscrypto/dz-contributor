import { NextResponse } from "next/server";
import { fetchOnchainTopology, isOnchainReady } from "@/lib/onchain/topology";
import { OnchainNotConfigured } from "@/lib/onchain/decoders";

export const revalidate = 60;
export const dynamic = "force-dynamic";

/**
 * Direct on-chain topology read. A/B against `/api/live/topology` (which
 * proxies malbeclabs HTTP). Returns 503 with a stable shape until DZ ships
 * the IDL and we wire the real decoders.
 */
export async function GET() {
  if (!isOnchainReady()) {
    return NextResponse.json(
      {
        ready: false,
        reason:
          "On-chain reader not configured. Set DZ_REGISTRY_PROGRAM_ID + ONCHAIN_ENABLED=1 once DZ ships the IDL.",
      },
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
      return NextResponse.json(
        { ready: false, reason: err.message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        ready: false,
        reason: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
