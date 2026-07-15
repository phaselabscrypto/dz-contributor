/**
 * Shared per-epoch Shapley computation.
 *
 * Single source of truth for "compute the Shapley result for epoch N" — used by
 * `/api/shapley?epoch=N` and `/api/shapley/baseline` (latest epoch). Owns a
 * per-epoch LRU so both routes hit the same warm cache; the heavy solve runs in
 * the Rust service (input-hash cached) or, in local dev only, the TS heuristic
 * solver.
 */
import { getSnapshotUrl, SHAPLEY_SERVICE_URL } from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ShapleyInput, ShapleyOutput } from "@/lib/types/shapley";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { buildShapleyInput } from "@/lib/utils/shapley-input-builder";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import { computeShapley as computeShapleyTS } from "@/lib/utils/shapley-solver";
import { computeShapleyRemote } from "@/lib/utils/shapley-remote";
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
/** The Rust Shapley service failed — surfaced as 502 (no silent algorithm swap). */
export class ShapleyServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShapleyServiceError";
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
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
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

/**
 * Compute (or return cached) the Shapley result for an epoch.
 * @throws EpochNotFoundError | ShapleyServiceError
 */
export async function getEpochShapley(epoch: number): Promise<EpochShapleyResult> {
  const cached = epochCache.get(epoch);
  if (cached !== undefined) return cached;

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
      throw new ShapleyServiceError(
        err instanceof Error ? err.message : "shapley service failed",
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
