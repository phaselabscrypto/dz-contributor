"use client";

import useSWR from "swr";

interface EpochsData {
  latest: number;
  earliest: number;
  available: number[];
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export function useEpochs() {
  return useSWR<EpochsData>("/api/epochs", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300000, // 5 min
  });
}
