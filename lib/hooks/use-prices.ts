"use client";

import useSWR from "swr";

export interface PricesData {
  twoZ: { usdPrice: number; priceChange24h: number };
  sol: { usdPrice: number; priceChange24h: number };
  twoZPerSol: number;
  solPer2Z: number;
  fetchedAt: string;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prices API error: ${res.status}`);
  return res.json();
};

export function usePrices() {
  return useSWR<PricesData>("/api/prices", fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 60_000,
    dedupingInterval: 30_000,
  });
}
