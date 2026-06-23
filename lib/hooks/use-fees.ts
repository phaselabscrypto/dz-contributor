"use client";

import useSWR from "swr";
import type { FeeHistory } from "@/lib/types/fees";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

export function useFees() {
  return useSWR<FeeHistory>("/api/fees", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300000, // 5 min
  });
}
