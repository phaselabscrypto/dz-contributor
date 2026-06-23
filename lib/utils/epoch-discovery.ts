/**
 * Shared epoch discovery against the DZ snapshot S3 bucket.
 *
 * Both `/api/epochs` and `/api/shapley/tracking` need the latest-N list.
 * Server code imports this helper directly rather than self-calling
 * `/api/epochs` over HTTP — on Vercel the second call competes with the
 * first for the same warmed-up function instance, a recipe for
 * cold-start deadlocks.
 *
 * Discovery uses HEAD requests against the snapshot URL template and a
 * binary search to find the highest epoch that exists. Cache is module-
 * scoped so concurrent callers within the same Vercel instance share
 * the result.
 */

import { getSnapshotUrl } from "@/lib/constants/config";

export interface EpochMeta {
  epoch: number;
  sizeBytes?: number;
  lastModified?: string;
}

export interface EpochAvailability {
  latest: number;
  earliest: number;
  available: number[];
  meta?: EpochMeta[];
}

let cache: { data: EpochAvailability; ts: number; withMeta: boolean } | null =
  null;
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Find the highest epoch number that exists in the snapshot bucket.
 * Exponential probe to find an upper bound, then binary search between
 * the last-known-good epoch and the probe miss. Avoids a hard-coded
 * ceiling that needs to be bumped every few months.
 */
async function discoverLatest(): Promise<number> {
  let lastOk = 48;
  let probe = 100;
  // Cap exponential growth at 10_000 to bound the number of HEADs.
  while (probe <= 10_000) {
    const res = await fetch(getSnapshotUrl(probe), {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      lastOk = probe;
      probe *= 2;
    } else {
      break;
    }
  }
  // Binary-search between `lastOk` and `probe` (exclusive).
  let low = lastOk;
  let high = probe;
  let latest = lastOk;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const res = await fetch(getSnapshotUrl(mid), {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      latest = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return latest;
}

async function headMeta(epoch: number): Promise<EpochMeta> {
  try {
    const res = await fetch(getSnapshotUrl(epoch), {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { epoch };
    const cl = res.headers.get("content-length");
    const lm = res.headers.get("last-modified");
    return {
      epoch,
      sizeBytes: cl ? parseInt(cl, 10) : undefined,
      lastModified: lm ?? undefined,
    };
  } catch {
    return { epoch };
  }
}

/**
 * Resolve the list of recent epochs available in the snapshot bucket.
 * Returns the latest 30 epochs by default; pass `withMeta=true` to also
 * HEAD each one for size + last-modified.
 */
export async function getEpochAvailability(
  withMeta = false,
): Promise<EpochAvailability> {
  if (
    cache &&
    Date.now() - cache.ts < CACHE_TTL &&
    cache.withMeta === withMeta
  ) {
    return cache.data;
  }

  const latest = await discoverLatest();
  const epochs: number[] = [];
  for (let e = latest; e >= Math.max(48, latest - 30); e--) {
    epochs.push(e);
  }

  let meta: EpochMeta[] | undefined;
  if (withMeta) {
    meta = await Promise.all(epochs.map(headMeta));
  }

  const data: EpochAvailability = {
    latest,
    earliest: 48,
    available: epochs,
    ...(meta ? { meta } : {}),
  };
  cache = { data, ts: Date.now(), withMeta };
  return data;
}
