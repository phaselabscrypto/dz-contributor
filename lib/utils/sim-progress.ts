import type { SimulateJobProgress } from "./shapley-remote";

/**
 * What the running modal shows for a simulate job, folded from one poll at
 * a time. Kept as one object so phase, percent, and the cache-hit inference
 * always change together in a single render.
 */
export interface SimProgress {
  phase: string | null;
  /** Per-phase 0-100, monotonic within a phase. */
  percent: number;
  /** True once any baseline poll reported progress; a cached baseline never does. */
  sawBaselineProgress: boolean;
  /** Decided by the first "modified" poll, then held for the run. */
  baselineCacheHit: boolean | null;
  coalitions: { solved: number; total: number } | null;
}

export const INITIAL_SIM_PROGRESS: SimProgress = {
  phase: null,
  percent: 0,
  sawBaselineProgress: false,
  baselineCacheHit: null,
  coalitions: null,
};

export interface AppliedPoll {
  next: SimProgress;
  /**
   * True on the poll that first reports a new phase after a known one. The
   * worker resets its counters before the store is flushed, so this poll can
   * still carry the previous phase's counters under the new label. Callers
   * must not feed its numbers to anything.
   */
  isPhaseFlip: boolean;
}

/** Fold one poll's `progress` into the previous state. Pure. */
export function applyPoll(
  prev: SimProgress,
  progress: SimulateJobProgress | null | undefined,
): AppliedPoll {
  const phase =
    typeof progress?.phase === "string" ? progress.phase : prev.phase;
  const reported =
    typeof progress?.percent === "number" ? progress.percent : prev.percent;
  const isPhaseFlip = prev.phase !== null && phase !== prev.phase;

  let percent: number;
  if (isPhaseFlip) {
    percent = 0;
  } else if (phase === prev.phase) {
    percent = Math.max(prev.percent, reported);
  } else {
    percent = reported;
  }

  const sawBaselineProgress =
    prev.sawBaselineProgress || (phase === "baseline" && percent > 0);
  const baselineCacheHit =
    prev.baselineCacheHit ??
    (phase === "modified" ? !sawBaselineProgress : null);

  let coalitions = isPhaseFlip ? null : prev.coalitions;
  if (
    !isPhaseFlip &&
    typeof progress?.coalitions_solved === "number" &&
    typeof progress?.coalitions_total === "number" &&
    progress.coalitions_total > 0
  ) {
    coalitions = {
      solved: progress.coalitions_solved,
      total: progress.coalitions_total,
    };
  }

  return {
    next: { phase, percent, sawBaselineProgress, baselineCacheHit, coalitions },
    isPhaseFlip,
  };
}
