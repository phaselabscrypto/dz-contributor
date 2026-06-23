"use client";

import useSWR from "swr";
import type { ShapleyResponse } from "@/lib/types/shapley";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export function useShapleyValues(epoch: number | null) {
  return useSWR<ShapleyResponse>(
    epoch !== null ? `/api/shapley?epoch=${epoch}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 300000, // 5 min
    }
  );
}
