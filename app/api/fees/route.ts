import { NextResponse } from "next/server";
import { FEE_CONSOLIDATED_URL } from "@/lib/constants/config";
import { parseConsolidatedCsv, computeFeeHistory } from "@/lib/utils/fee-parser";
import { reportError } from "@/lib/observability";

let feeCache: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Fees update at most once per Solana epoch (~2 days), and the
// upstream CSV is published manually by the Foundation. 10 min server
// cache + 10 min CDN cache is conservative.
const CACHE_CONTROL =
  "public, max-age=600, s-maxage=600, stale-while-revalidate=1800";

export async function GET() {
  // Check cache
  if (feeCache && Date.now() - feeCache.timestamp < CACHE_TTL) {
    return NextResponse.json(feeCache.data, {
      headers: { "Cache-Control": CACHE_CONTROL },
    });
  }

  try {
    const res = await fetch(FEE_CONSOLIDATED_URL, {
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to fetch fees: ${res.status}` },
        { status: res.status }
      );
    }

    const csv = await res.text();
    const epochs = parseConsolidatedCsv(csv);
    const history = await computeFeeHistory(epochs);

    // Cache it
    feeCache = { data: history, timestamp: Date.now() };

    return NextResponse.json(history, {
      headers: { "Cache-Control": CACHE_CONTROL },
    });
  } catch (err) {
    reportError(err, { source: "api/fees" });
    // Generic to the client — ${err} can carry upstream fetch detail.
    return NextResponse.json(
      { error: "Failed to fetch fees" },
      { status: 500 }
    );
  }
}
