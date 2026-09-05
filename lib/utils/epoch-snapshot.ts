import { getSnapshotUrl, SNAPSHOT_FETCH_TIMEOUT_MS } from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import { boundedSignal, type RequestDeadline } from "@/lib/utils/request-deadline";

export class EpochSnapshotError extends Error {
  constructor(readonly epoch: number, readonly category: "http" | "timeout" | "aborted" | "json" | "envelope" | "epoch-mismatch" | "network", readonly status?: number) {
    super(`epoch ${epoch}: snapshot ${category}${status === undefined ? "" : ` HTTP ${status}`}`);
    this.name = "EpochSnapshotError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function fetchEpochSnapshot(expectedEpoch: number, options: RequestDeadline = {}): Promise<RawSnapshot> {
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_FETCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const signal = boundedSignal(options, SNAPSHOT_FETCH_TIMEOUT_MS);
  try {
    signal.throwIfAborted();
    const response = await fetch(getSnapshotUrl(expectedEpoch), { signal });
    if (!response.ok) throw new EpochSnapshotError(expectedEpoch, "http", response.status);
    const text = await response.text();
    signal.throwIfAborted();
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new EpochSnapshotError(expectedEpoch, "json"); }
    if (Date.now() >= deadline) throw new EpochSnapshotError(expectedEpoch, "timeout");
    signal.throwIfAborted();
    if (!isRecord(data) || !Number.isInteger(data.dz_epoch) || !isRecord(data.fetch_data)
      || !isRecord(data.fetch_data.dz_serviceability)) {
      throw new EpochSnapshotError(expectedEpoch, "envelope");
    }
    if (data.dz_epoch !== expectedEpoch) throw new EpochSnapshotError(expectedEpoch, "epoch-mismatch");
    // Extractors validate the detailed collections after this identity check.
    return data as unknown as RawSnapshot;
  } catch (error) {
    if (error instanceof EpochSnapshotError) throw error;
    if (signal.aborted) throw new EpochSnapshotError(expectedEpoch, options.signal?.aborted ? "aborted" : "timeout");
    throw new EpochSnapshotError(expectedEpoch, "network");
  }
}
