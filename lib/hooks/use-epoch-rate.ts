"use client";

import useSWR from "swr";
import {
  FALLBACK_EPOCH_RATE,
  type EpochRate,
} from "@/lib/utils/epoch-rate";

const fetcher = async (url: string): Promise<EpochRate> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

/**
 * Measured epoch rate for monthly and yearly projections.
 *
 * Unlike the other hooks in this directory it returns the value rather than
 * the SWR result object. Every consumer multiplies a SOL figure by it and
 * needs a number synchronously, so a loading state would only be branched on
 * to substitute the fallback anyway. `source` distinguishes a real measurement
 * from the fallback for callers that want to say so.
 */
export function useEpochRate(): EpochRate {
  const { data } = useSWR<EpochRate>("/api/epoch-rate", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 3_600_000,
  });
  return data ?? FALLBACK_EPOCH_RATE;
}
