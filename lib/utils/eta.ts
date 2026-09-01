import { formatDuration } from "./format";

/**
 * Rolling time-remaining estimate for a phased solve, computed from the
 * slope of a monotonic counter (coalitions solved) against the caller's
 * clock. Pure: no Date, no React. The caller feeds one sample per poll.
 *
 * The estimate anchors at the first sample with live progress in a phase
 * and measures the rate from that anchor, so two known distortions do not
 * leak in: the cold-baseline priming window where the counter sits at 0,
 * and the modified phase's instant credit for reused cities.
 */

/** Progress must move this fraction of the total past the anchor before an estimate shows. */
export const ETA_MIN_PROGRESS_FRACTION = 0.02;
/** Wall time that must pass after the anchor before an estimate shows. */
export const ETA_MIN_ELAPSED_MS = 5_000;
/** Weight of the newest measured rate in the smoothed rate. */
export const ETA_SMOOTHING_ALPHA = 0.3;

export interface EtaSample {
  phase: string | null;
  /** Caller's monotonic clock, milliseconds (e.g. `performance.now()`). */
  nowMs: number;
  solved: number;
  total: number;
}

export interface EtaState {
  phase: string | null;
  total: number;
  anchor: { t: number; solved: number } | null;
  /** Units solved per millisecond since the anchor, EWMA-smoothed. */
  smoothedRatePerMs: number | null;
  smoothedRemainingMs: number | null;
}

export const INITIAL_ETA_STATE: EtaState = {
  phase: null,
  total: 0,
  anchor: null,
  smoothedRatePerMs: null,
  smoothedRemainingMs: null,
};

/**
 * Fold one poll into the estimator state and return the next state.
 * Re-anchors when the phase or the denominator changes, or when the
 * counter goes backwards (a phase reset the caller has not yet labelled).
 */
export function advanceEta(state: EtaState, sample: EtaSample): EtaState {
  const { phase, nowMs, solved, total } = sample;

  const isNewPhase =
    phase !== state.phase ||
    total !== state.total ||
    (state.anchor !== null && solved < state.anchor.solved);
  const base: EtaState = isNewPhase
    ? {
        phase,
        total,
        anchor: null,
        smoothedRatePerMs: null,
        smoothedRemainingMs: null,
      }
    : state;

  if (total <= 0 || solved <= 0 || solved >= total) {
    return base;
  }

  if (base.anchor === null) {
    return { ...base, anchor: { t: nowMs, solved } };
  }

  const progressed = solved - base.anchor.solved;
  const elapsed = nowMs - base.anchor.t;
  const hasEnoughProgress = progressed >= ETA_MIN_PROGRESS_FRACTION * total;
  const hasEnoughTime = elapsed >= ETA_MIN_ELAPSED_MS;
  if (!hasEnoughProgress || !hasEnoughTime || progressed <= 0 || elapsed <= 0) {
    return base;
  }

  // Smooth the rate, not the remaining time. On steady progress the rate is
  // constant, so the smoothed value converges and the estimate stays exact.
  const rawRatePerMs = progressed / elapsed;
  const smoothedRatePerMs =
    base.smoothedRatePerMs === null
      ? rawRatePerMs
      : ETA_SMOOTHING_ALPHA * rawRatePerMs +
        (1 - ETA_SMOOTHING_ALPHA) * base.smoothedRatePerMs;
  const smoothedRemainingMs = (total - solved) / smoothedRatePerMs;

  return { ...base, smoothedRatePerMs, smoothedRemainingMs };
}

/** "about 6 min left", or null while the estimator has no estimate yet. */
export function etaLabel(state: EtaState): string | null {
  if (state.smoothedRemainingMs === null) return null;
  return `${formatDuration(state.smoothedRemainingMs)} left`;
}
