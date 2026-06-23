/**
 * Live SOL/USD spot price from Jupiter Price API v3.
 *
 * Jupiter v2 (`api.jup.ag/price/v2`) was deprecated and returns 404. The
 * current free-tier endpoint is `lite-api.jup.ag/price/v3`. Response
 * shape changed too — v3 returns `{ [mint]: { usdPrice, ... } }`.
 *
 * The 2Z token is not currently tradeable on Jupiter (DZ Foundation
 * confirmed 2Z payouts are not active), so there is no 2Z/SOL price
 * to fetch. Fee revenue is recorded in lamports on-chain and we
 * derive SOL → USD here for display.
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_V3 = `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`;

interface JupiterV3Response {
  [mint: string]: {
    usdPrice?: number;
    decimals?: number;
    priceChange24h?: number;
  };
}

export async function fetchSolUsdPrice(): Promise<number | null> {
  try {
    const response = await fetch(JUPITER_V3, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`Jupiter v3 returned ${response.status}`);
      return null;
    }
    const data = (await response.json()) as JupiterV3Response;
    const price = data[SOL_MINT]?.usdPrice;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      console.warn("Jupiter v3 returned no usdPrice for SOL");
      return null;
    }
    return price;
  } catch (err) {
    console.warn(`Jupiter v3 fetch failed: ${err}`);
    return null;
  }
}

/**
 * Deprecated: kept as a no-op for any leftover callers. Always returns null.
 * The 2Z token does not trade on Jupiter; there is no live 2Z/SOL price.
 */
export async function fetch2ZPrice(): Promise<number | null> {
  return null;
}

/**
 * Deprecated: 2Z conversion is not supported. Returns the input unchanged.
 */
export function convert2ZToSOL(amount2Z: number, _pricePerUnit: number): number {
  void _pricePerUnit;
  return amount2Z;
}
