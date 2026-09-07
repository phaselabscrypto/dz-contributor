import {
  getSnapshotUrl,
  SNAPSHOT_FETCH_TIMEOUT_MS,
} from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import {
  boundedSignal,
  type RequestDeadline,
} from "@/lib/utils/request-deadline";

export type EpochSnapshotFailure =
  | "http"
  | "timeout"
  | "aborted"
  | "json"
  | "envelope"
  | "epoch-mismatch"
  | "network";

/** Why a snapshot could not be used; `status` is set for the `http` category. */
export class EpochSnapshotError extends Error {
  constructor(
    readonly epoch: number,
    readonly category: EpochSnapshotFailure,
    readonly status?: number,
    options: { cause?: unknown } = {},
  ) {
    super(
      describeFailure(epoch, category, status),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "EpochSnapshotError";
  }
}

function describeFailure(
  epoch: number,
  category: EpochSnapshotFailure,
  status: number | undefined,
): string {
  const reason =
    category === "http" && status !== undefined ? `HTTP ${status}` : category;
  return `epoch ${epoch}: snapshot ${reason}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Download one epoch's snapshot and check that it is the epoch asked for.
 * Only the envelope is validated here; the extractors check the collections.
 */
export async function fetchEpochSnapshot(
  expectedEpoch: number,
  options: RequestDeadline = {},
): Promise<RawSnapshot> {
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_FETCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const signal = boundedSignal(options, SNAPSHOT_FETCH_TIMEOUT_MS);
  try {
    signal.throwIfAborted();
    const response = await fetch(getSnapshotUrl(expectedEpoch), { signal });
    if (!response.ok) {
      throw new EpochSnapshotError(expectedEpoch, "http", response.status);
    }
    const text = await response.text();
    signal.throwIfAborted();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new EpochSnapshotError(expectedEpoch, "json", undefined, {
        cause: error,
      });
    }
    // JSON.parse is synchronous, so the abort timer cannot fire during it;
    // the wall clock is the only way to notice that the deadline passed.
    if (Date.now() >= deadline) {
      throw new EpochSnapshotError(expectedEpoch, "timeout");
    }
    signal.throwIfAborted();
    if (
      !isRecord(data) ||
      !Number.isInteger(data.dz_epoch) ||
      !isRecord(data.fetch_data) ||
      !isRecord(data.fetch_data.dz_serviceability)
    ) {
      throw new EpochSnapshotError(expectedEpoch, "envelope");
    }
    if (data.dz_epoch !== expectedEpoch) {
      throw new EpochSnapshotError(expectedEpoch, "epoch-mismatch");
    }
    return data as unknown as RawSnapshot;
  } catch (error) {
    if (error instanceof EpochSnapshotError) throw error;
    if (signal.aborted) {
      const category = options.signal?.aborted ? "aborted" : "timeout";
      throw new EpochSnapshotError(expectedEpoch, category, undefined, {
        cause: error,
      });
    }
    throw new EpochSnapshotError(expectedEpoch, "network", undefined, {
      cause: error,
    });
  }
}
