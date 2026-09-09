import { NextResponse } from "next/server";
import type { BaselineNotCached, EpochBaseline } from "@/lib/types/baseline";
import type { RequestDeadline } from "@/lib/utils/request-deadline";
import { fetchBaselineByTagRemote } from "@/lib/utils/shapley-remote";
import { baselineTag } from "@/lib/utils/sweep-tag";

/**
 * Shared read path of the cache-only baseline routes: probe the epoch alias on
 * the Rust service and turn the answer into the wire body those routes return.
 * Nothing here computes or enqueues.
 */

export const LATEST_BASELINE_CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
export const EPOCH_BASELINE_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
export const SERVICE_UNAVAILABLE_BODY = {
  error: "Service temporarily unavailable",
} as const;

export type EpochBaselineProbe =
  | { status: "hit"; body: EpochBaseline }
  | { status: "miss"; body: BaselineNotCached };

export async function probeEpochBaseline(
  epoch: number,
  options: RequestDeadline = {},
): Promise<EpochBaselineProbe> {
  const tag = baselineTag(epoch);
  const probe = await fetchBaselineByTagRemote(tag, options);
  if (probe.status === "miss") {
    return { status: "miss", body: { status: "not-cached", epoch, tag } };
  }
  const { output, method } = probe.result;
  return {
    status: "hit",
    body: {
      epoch,
      tag,
      method,
      operatorCount: Object.keys(output).length,
      values: output,
      fetchedAt: new Date().toISOString(),
    },
  };
}

/** All probes run concurrently; one thrown error rejects the set (a service error is not a miss). */
export function probeEpochBaselines(
  epochs: readonly number[],
  options: RequestDeadline = {},
): Promise<EpochBaselineProbe[]> {
  return Promise.all(epochs.map((epoch) => probeEpochBaseline(epoch, options)));
}

/** 200 with the hit header, or 404 no-store. */
export function baselineResponse(
  probe: EpochBaselineProbe,
  hitCacheControl: string,
): NextResponse {
  if (probe.status === "hit") {
    return NextResponse.json(probe.body, {
      headers: { "Cache-Control": hitCacheControl },
    });
  }
  return NextResponse.json(probe.body, {
    status: 404,
    headers: NO_STORE_HEADERS,
  });
}
