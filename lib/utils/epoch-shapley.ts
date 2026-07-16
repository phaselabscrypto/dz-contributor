/**
 * Shared per-epoch Shapley computation.
 *
 * Single source of truth for "compute the Shapley result for epoch N" — used by
 * `/api/shapley?epoch=N` and `/api/shapley/baseline` (latest epoch). The
 * per-epoch LRU here is per-instance AND per-route-function on Vercel (each
 * route compiles to its own serverless function), so it dedupes repeated hits
 * to the SAME route; the cross-route warm cache is the Rust service's
 * input-hash result cache (S3-backed, warmed by the precompute cron). In local
 * dev without a service URL, the TS heuristic solver runs instead.
 */
import {
  getSnapshotUrl,
  SHAPLEY_SERVICE_URL,
  SNAPSHOT_FETCH_TIMEOUT_MS,
} from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ShapleyInput, ShapleyOutput } from "@/lib/types/shapley";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { buildShapleyInput } from "@/lib/utils/shapley-input-builder";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import { computeShapley as computeShapleyTS } from "@/lib/utils/shapley-solver";
import {
  computeShapleyRemote,
  RemoteSolveError,
} from "@/lib/utils/shapley-remote";
import { fetchCanonicalInput, isCanonicalEnabled } from "@/lib/utils/canonical-inputs";
import { LruCache } from "@/lib/utils/lru-cache";

// Wire-facing `inputSource` labels — unchanged (the UI + /methodology parse them).
export type InputSource =
  | "canonical-foundation"
  | "canonical-snapshot"
  | "snapshot-heuristic";

export interface EpochShapleyResult {
  epoch: number;
  method: string;
  inputSource: InputSource;
  inputFallbackReason?: string;
  operatorCount: number;
  values: ShapleyOutput;
  inputSummary: {
    deviceCount: number;
    privateLinkCount: number;
    publicLinkCount: number;
    demandCount: number;
  };
}

/** Snapshot for the epoch doesn't exist (typically a 404 from the S3 store). */
export class EpochNotFoundError extends Error {
  constructor(readonly epoch: number) {
    super(`Epoch ${epoch} not found`);
    this.name = "EpochNotFoundError";
  }
}
/**
 * The Rust Shapley service failed — surfaced as 502 (no silent algorithm
 * swap), EXCEPT when `warming` is true: a timeout-class failure (client-side
 * abort, or upstream 504 from the HAProxy route / 408 from the service's own
 * TimeoutLayer) means a solve was cut mid-flight — the epoch exists but isn't
 * cached yet. The baseline route maps that to 202. Everything else (router
 * 502/503, Rust 4xx/5xx, network refusal, misconfiguration) is a hard 502.
 */
export class ShapleyServiceError extends Error {
  readonly warming: boolean;
  /** Upstream HTTP status, when a response arrived — for observability. */
  readonly status?: number;
  constructor(message: string, source?: unknown) {
    super(message);
    this.name = "ShapleyServiceError";
    if (source instanceof RemoteSolveError) {
      this.status = source.status;
      this.warming =
        source.timedOut || source.status === 504 || source.status === 408;
    } else {
      this.warming = false;
    }
  }
}

// TTL 30min; inputs are immutable historical snapshots so a hit is always valid.
const epochCache = new LruCache<number, EpochShapleyResult>({
  ttlMs: 30 * 60 * 1000,
  maxSize: 32,
});

/**
 * Build the Shapley input for an epoch (foundation CSVs → snapshot builder →
 * heuristic fallback), matching the `/api/shapley` priority chain. Throws
 * {@link EpochNotFoundError} when the snapshot is absent.
 */
export async function buildInputForEpoch(epoch: number): Promise<{
  input: ShapleyInput;
  inputSource: InputSource;
  inputFallbackReason?: string;
}> {
  if (isCanonicalEnabled) {
    const foundation = await fetchCanonicalInput(epoch);
    if (foundation) {
      return { input: foundation, inputSource: "canonical-foundation" };
    }
  }

  const url = getSnapshotUrl(epoch);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    if (res.status === 404) throw new EpochNotFoundError(epoch);
    throw new Error(`Snapshot fetch for epoch ${epoch} failed: HTTP ${res.status}`);
  }
  const raw = (await res.json()) as RawSnapshot;

  const built = buildCanonicalShapleyInput(raw);
  if (built.canonical) {
    return { input: built.input, inputSource: "canonical-snapshot" };
  }
  const parsed = parseSnapshot(raw);
  return {
    input: buildShapleyInput(raw, parsed),
    inputSource: "snapshot-heuristic",
    inputFallbackReason: built.reason,
  };
}

// Single-flight: the LRU stores only RESOLVED results, so without this every
// concurrent cold request for the same epoch would fire its own snapshot
// download + remote solve. Entries are removed as soon as the promise settles
// (failures are never cached).
const inFlight = new Map<number, Promise<EpochShapleyResult>>();

/**
 * Compute (or return cached) the Shapley result for an epoch. Concurrent
 * callers for the same cold epoch share one in-flight computation.
 * @throws EpochNotFoundError | ShapleyServiceError
 */
export async function getEpochShapley(epoch: number): Promise<EpochShapleyResult> {
  const cached = epochCache.get(epoch);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(epoch);
  if (pending !== undefined) return pending;

  const promise = computeEpochShapley(epoch).finally(() => {
    inFlight.delete(epoch);
  });
  inFlight.set(epoch, promise);
  return promise;
}

async function computeEpochShapley(epoch: number): Promise<EpochShapleyResult> {
  const { input, inputSource, inputFallbackReason } = await buildInputForEpoch(epoch);

  let output: ShapleyOutput;
  let method: string;
  if (SHAPLEY_SERVICE_URL) {
    try {
      const remote = await computeShapleyRemote(input);
      output = remote.output;
      method = remote.method;
    } catch (err) {
      // No silent fallback to the TS heuristic in production (PR #7 review).
      // The source error drives the warming classification (see class doc).
      throw new ShapleyServiceError(
        err instanceof Error ? err.message : "shapley service failed",
        err,
      );
    }
  } else {
    output = computeShapleyTS(input);
    method = "local-ts-heuristic-DEV-ONLY";
  }

  const result: EpochShapleyResult = {
    epoch,
    method,
    inputSource,
    inputFallbackReason,
    operatorCount: Object.keys(output).length,
    values: output,
    inputSummary: {
      deviceCount: input.devices.length,
      privateLinkCount: input.private_links.length,
      publicLinkCount: input.public_links.length,
      demandCount: input.demands.length,
    },
  };
  epochCache.set(epoch, result);
  return result;
}
