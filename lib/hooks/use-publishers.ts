"use client";

import useSWR from "swr";
import type { PublisherCheckResponse } from "@/lib/types/publisher";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Publisher API error: ${res.status}`);
  return res.json();
};

export function usePublishers() {
  return useSWR<PublisherCheckResponse>("/api/publishers", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300000, // 5 min
  });
}
