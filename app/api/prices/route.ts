import { NextResponse } from "next/server";
import { reportError } from "@/lib/observability";

const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const TWO_Z_MINT = "J6pQQ3FAcJQeWPPGppWRb4nM8jU3wLyYbRrLh7feMfvd";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// In-memory cache — Jupiter prices are fine for ~60s TTL
const CACHE_TTL = 60 * 1000;
let cache: { data: PricesResponse; timestamp: number } | null = null;

interface JupiterPrice {
  usdPrice: number;
  priceChange24h: number;
}

interface PricesResponse {
  twoZ: { usdPrice: number; priceChange24h: number };
  sol: { usdPrice: number; priceChange24h: number };
  // 1 SOL = N × 2Z (used to convert SOL-equivalent amounts to 2Z)
  solPer2Z: number;
  twoZPerSol: number;
  fetchedAt: string;
}

export async function GET() {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  try {
    const res = await fetch(
      `${JUPITER_PRICE_URL}?ids=${TWO_Z_MINT},${SOL_MINT}`,
      { signal: AbortSignal.timeout(8000) },
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: `Jupiter price API returned ${res.status}` },
        { status: 502 },
      );
    }

    const raw = (await res.json()) as Record<string, JupiterPrice>;
    const twoZ = raw[TWO_Z_MINT];
    const sol = raw[SOL_MINT];

    if (!twoZ?.usdPrice || !sol?.usdPrice) {
      return NextResponse.json(
        { error: "Jupiter response missing price data" },
        { status: 502 },
      );
    }

    const data: PricesResponse = {
      twoZ: { usdPrice: twoZ.usdPrice, priceChange24h: twoZ.priceChange24h },
      sol: { usdPrice: sol.usdPrice, priceChange24h: sol.priceChange24h },
      twoZPerSol: sol.usdPrice / twoZ.usdPrice,
      solPer2Z: twoZ.usdPrice / sol.usdPrice,
      fetchedAt: new Date().toISOString(),
    };

    cache = { data, timestamp: Date.now() };
    return NextResponse.json(data);
  } catch (err) {
    // Full detail server-side only — upstream errors can name hosts/keys.
    reportError(err, { source: "api/prices" });
    return NextResponse.json(
      { error: "Failed to fetch prices" },
      { status: 500 },
    );
  }
}
