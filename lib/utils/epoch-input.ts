/**
 * Shapley input construction per epoch for the precompute cron: foundation
 * CSVs, else the snapshot builder.
 */
import {
  getSnapshotUrl,
  SNAPSHOT_FETCH_TIMEOUT_MS,
} from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ShapleyInput } from "@/lib/types/shapley";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { buildShapleyInput } from "@/lib/utils/shapley-input-builder";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import {
  fetchCanonicalInput,
  isCanonicalEnabled,
} from "@/lib/utils/canonical-inputs";

// Wire-facing `inputSource` labels — the UI and /methodology parse them.
export type InputSource =
  | "canonical-foundation"
  | "canonical-snapshot"
  | "snapshot-heuristic";

/** Snapshot for the epoch doesn't exist (typically a 404 from the S3 store). */
export class EpochNotFoundError extends Error {
  constructor(readonly epoch: number) {
    super(`Epoch ${epoch} not found`);
    this.name = "EpochNotFoundError";
  }
}

export interface BuiltEpochInput {
  input: ShapleyInput;
  inputSource: InputSource;
  inputFallbackReason?: string;
}

/**
 * Build the Shapley input for an epoch (foundation CSVs → snapshot builder →
 * heuristic fallback). Throws {@link EpochNotFoundError} when the snapshot is
 * absent.
 */
export async function buildInputForEpoch(
  epoch: number,
): Promise<BuiltEpochInput> {
  if (isCanonicalEnabled) {
    const foundation = await fetchCanonicalInput(epoch);
    if (foundation) {
      return { input: foundation, inputSource: "canonical-foundation" };
    }
  }
  return buildSnapshotInputForEpoch(epoch);
}

/**
 * Build the SNAPSHOT-derived input variant (canonical builder → heuristic
 * fallback), bypassing the foundation CSVs. This is the variant the
 * simulate/jobs routes build; it hashes differently from the foundation
 * variant on the Rust service's cache, so the precompute cron warms both.
 * Throws {@link EpochNotFoundError} when the snapshot is absent.
 */
export async function buildSnapshotInputForEpoch(
  epoch: number,
): Promise<BuiltEpochInput> {
  const url = getSnapshotUrl(epoch);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    if (res.status === 404) throw new EpochNotFoundError(epoch);
    throw new Error(
      `Snapshot fetch for epoch ${epoch} failed: HTTP ${res.status}`,
    );
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
