"use client";

import useSWR from "swr";
import {
  FALLBACK_EPOCH_RATE,
  toPublicEpochRate,
  type PublicEpochRate,
} from "@/lib/utils/epoch-rate";

const FALLBACK = toPublicEpochRate(FALLBACK_EPOCH_RATE);

const fetcher = async (url: string): Promise<PublicEpochRate> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

/**
 * Measured epoch cadence for monthly and yearly projections.
 *
 * Unlike the other hooks here it returns the value rather than the SWR result
 * object. Every consumer multiplies a SOL figure by it and needs a number
 * synchronously, so a loading state would only be branched on to substitute
 * the fallback anyway.
 */
export function useEpochRate(): PublicEpochRate {
  const { data } = useSWR<PublicEpochRate>("/api/epoch-rate", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 3_600_000,
  });
  return data ?? FALLBACK;
}
