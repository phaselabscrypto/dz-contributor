import { formatDuration } from "./format";

/**
 * Per-browser record of completed simulate runs, used only to tell the
 * user how long a run usually takes before they start one. Persisted by
 * the simulate tab under `RUN_HISTORY_KEY` via `useLocalStorageState`.
 */

export const RUN_HISTORY_KEY = "dz:simulate:run-history";
export const RUN_HISTORY_MAX = 5;

/** Shown when the browser has no completed runs yet. */
export const RUNTIME_FALLBACK_LABEL = "Runs usually take 5 to 15 minutes";

export interface RunRecord {
  /** baseline_ms + modified_ms from the service's stats. */
  totalMs: number;
  baselineCacheHit: boolean;
  epoch: number;
  /** ISO timestamp of completion. */
  finishedAt: string;
}

/** Prepend a record and keep the newest `RUN_HISTORY_MAX`. Does not mutate. */
export function pushRun(history: RunRecord[], record: RunRecord): RunRecord[] {
  return [record, ...history].slice(0, RUN_HISTORY_MAX);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One line of copy for the run button and the confirm screen. */
export function typicalRuntimeLabel(history: RunRecord[]): string {
  const durations = history
    .map((r) => r.totalMs)
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (durations.length === 0) return RUNTIME_FALLBACK_LABEL;
  return `Recent runs took ${formatDuration(median(durations))}`;
}
