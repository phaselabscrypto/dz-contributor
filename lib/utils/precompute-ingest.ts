import {
  MIN_DZ_EPOCH,
  SNAPSHOT_FETCH_TIMEOUT_MS,
} from "@/lib/constants/config";
import { reportError } from "@/lib/observability";
import type { ShapleyInput } from "@/lib/types/shapley";
import type { RawSnapshot } from "@/lib/types/snapshot";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import { scheduleDiffRepairs } from "@/lib/utils/diff-repair-schedule";
import { extractDiffShape } from "@/lib/utils/diff-shape";
import { MAX_DIFF_EPOCH } from "@/lib/utils/diff-window";
import { getEpochAvailability } from "@/lib/utils/epoch-discovery";
import {
  EpochSnapshotError,
  fetchEpochSnapshot,
} from "@/lib/utils/epoch-snapshot";
import {
  boundedSignal,
  type RequestDeadline,
} from "@/lib/utils/request-deadline";
import {
  type BaselinePrecompute,
  JobStartError,
  fetchMissingDiffShapes,
  getSweepStatus,
  putDiffShape,
  startBaselinePrecompute,
  startLinkEstimateSweep,
} from "@/lib/utils/shapley-remote";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { sweepTag } from "@/lib/utils/sweep-tag";

/** Work stops here so the response is written inside the 300 s function limit. */
export const CRON_WORK_TIMEOUT_MS = 270_000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 12_000;
const SERVICE_CALL_TIMEOUT_MS = 15_000;
const SHAPE_PUT_TIMEOUT_MS = 30_000;
/** Historical repairs share this budget inside the fire's. */
const REPAIR_WORK_TIMEOUT_MS = 90_000;
/** One historical download, extraction, and write. */
const REPAIR_ATTEMPT_TIMEOUT_MS = 40_000;
/** Shape downloads per fire, the current epoch included. */
const MAX_SHAPE_ATTEMPTS_PER_FIRE = 3;
/** Matches the 31 epochs the changelog selector offers. */
const DIFF_REPAIR_DEPTH = 31;
/** The cron cadence; historical candidates rotate once per slot. */
const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SOURCE = "api/link-value/precompute";

type ShapeOutcome = "created" | "exists" | "failed";
type SweepOutcome = "already-swept" | "accepted" | "failed";
type BaselineOutcome = BaselinePrecompute | { error: string };
type ShapesBody = Record<number, ShapeOutcome> & {
  deferred: number;
  deferred_epochs: number[];
  failed_epochs: number[];
};

interface PrecomputeBody {
  epoch?: number;
  tag?: string;
  sweep?: SweepOutcome;
  sweep_job_id?: string;
  operators?: number;
  baseline?: BaselineOutcome;
  shapes?: ShapesBody;
  errors?: Record<string, string>;
  error?: string;
}

export interface PrecomputeResult {
  status: number;
  body: PrecomputeBody;
}

export interface PrecomputeOptions {
  signal?: AbortSignal;
  startedAtMs?: number;
  /** Injectable clock for tests. */
  nowMs?: () => number;
}

interface Failure {
  message: string;
  status: number;
}

/**
 * The fire's time budget. Every call derives its timeout from what remains,
 * and `check` turns an exhausted budget into a 504 before the next step.
 */
class WorkBudget {
  readonly signal: AbortSignal;

  constructor(
    readonly deadline: number,
    readonly now: () => number,
    parent?: AbortSignal,
  ) {
    this.signal = boundedSignal(
      { signal: parent, timeoutMs: Math.max(1, deadline - now()) },
      CRON_WORK_TIMEOUT_MS,
    );
  }

  remainingMs(): number {
    return this.deadline - this.now();
  }

  /** Throws once the fire is aborted or `until` (default: the deadline) has passed. */
  check(until = this.deadline): void {
    if (this.signal.aborted || this.now() >= Math.min(this.deadline, until)) {
      throw new JobStartError("precompute work deadline exceeded", 504);
    }
  }

  /** Deadline options for one call, capped by the remaining budget. */
  callOptions(
    timeoutMs = SERVICE_CALL_TIMEOUT_MS,
    signal: AbortSignal = this.signal,
  ): RequestDeadline {
    this.check();
    signal.throwIfAborted();
    return { signal, timeoutMs: Math.min(timeoutMs, this.remainingMs()) };
  }
}

/** Reports each failure once and keeps its message for the response body. */
class FailureLog {
  readonly errors: Record<string, string> = {};
  epoch?: number;

  record(phase: string, error: unknown): Failure {
    const extras: Record<string, unknown> = { epoch: this.epoch, phase };
    if (error instanceof JobStartError && error.detail !== undefined) {
      extras.detail = error.detail;
    }
    reportError(error, { source: SOURCE, extras });
    const failure = describeFailure(error);
    this.errors[phase] = failure.message;
    return failure;
  }
}

/** A message safe for the response body, and the status it implies. */
function describeFailure(error: unknown): Failure {
  if (error instanceof JobStartError) {
    return { message: error.message, status: error.status };
  }
  if (error instanceof EpochSnapshotError) {
    return { message: error.message, status: snapshotFailureStatus(error) };
  }
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return { message: "precompute work timed out or aborted", status: 504 };
  }
  return { message: "precompute work failed", status: 502 };
}

function snapshotFailureStatus(error: EpochSnapshotError): number {
  switch (error.category) {
    case "timeout":
    case "aborted":
      return 504;
    case "epoch-mismatch":
    case "envelope":
    case "json":
      return 422;
    case "http":
      return error.status === 404 ? 404 : 502;
    case "network":
      return 502;
  }
}

/** `?epoch=N` must be an integer inside the diff window. */
function parseEpochParam(param: string): number | null {
  const epoch = /^[+-]?\d+$/.test(param.trim()) ? Number(param) : NaN;
  const isInWindow =
    Number.isInteger(epoch) && epoch >= MIN_DZ_EPOCH && epoch <= MAX_DIFF_EPOCH;
  return isInWindow ? epoch : null;
}

async function discoverLatestEpoch(budget: WorkBudget): Promise<number> {
  const signal = boundedSignal(
    budget.callOptions(DISCOVERY_TIMEOUT_MS),
    DISCOVERY_TIMEOUT_MS,
  );
  return (await getEpochAvailability(false, { signal })).latest;
}

interface EpochState {
  isSwept: boolean;
  missing: number[];
}

async function checkSweep(tag: string, budget: WorkBudget): Promise<boolean> {
  const status = await getSweepStatus(
    tag,
    budget.callOptions(STATUS_TIMEOUT_MS),
  );
  return status.complete;
}

async function listMissingShapes(
  epoch: number,
  budget: WorkBudget,
): Promise<number[]> {
  return fetchMissingDiffShapes(
    epoch,
    DIFF_REPAIR_DEPTH,
    budget.callOptions(STATUS_TIMEOUT_MS),
  );
}

/**
 * Both reads run concurrently. Either failing falls back to doing the work,
 * which is idempotent, so a failed check costs time and never correctness.
 */
async function readEpochState(
  epoch: number,
  tag: string,
  budget: WorkBudget,
  failures: FailureLog,
): Promise<EpochState> {
  const [sweepCheck, missingCheck] = await Promise.allSettled([
    checkSweep(tag, budget),
    listMissingShapes(epoch, budget),
  ]);
  if (sweepCheck.status === "rejected") {
    failures.record("marker-check", sweepCheck.reason);
  }
  if (missingCheck.status === "rejected") {
    failures.record("missing-shapes", missingCheck.reason);
  }
  return {
    isSwept: sweepCheck.status === "fulfilled" && sweepCheck.value,
    // Unknown gaps: assume at least the current epoch needs its shape.
    missing: missingCheck.status === "fulfilled" ? missingCheck.value : [epoch],
  };
}

interface CurrentEpochWork {
  epoch: number;
  tag: string;
  isSwept: boolean;
  needsShape: boolean;
}

interface SweepSubmission {
  sweep: SweepOutcome;
  sweepJobId?: string;
  operators?: number;
  baseline?: BaselineOutcome;
  /** 200 unless the sweep could not be submitted. */
  status: number;
}

interface CurrentEpochResult extends SweepSubmission {
  shape?: ShapeOutcome;
}

/**
 * The current snapshot is downloaded once and used for both the sweep and
 * the shape. The sweep goes first because it is the fire's primary output. A
 * shape failure after an accepted sweep still fails the response, because
 * the current shape is required work.
 */
async function runCurrentEpoch(
  work: CurrentEpochWork,
  budget: WorkBudget,
  failures: FailureLog,
): Promise<CurrentEpochResult> {
  if (work.isSwept && !work.needsShape) {
    return { sweep: "already-swept", status: 200 };
  }
  let raw: RawSnapshot;
  try {
    raw = await fetchEpochSnapshot(
      work.epoch,
      budget.callOptions(SNAPSHOT_FETCH_TIMEOUT_MS),
    );
    budget.check();
  } catch (error) {
    return {
      sweep: work.isSwept ? "already-swept" : "failed",
      shape: work.needsShape ? "failed" : undefined,
      status: failures.record("current-snapshot", error).status,
    };
  }
  const submission: SweepSubmission = work.isSwept
    ? { sweep: "already-swept", status: 200 }
    : await submitSweep(raw, work, budget, failures);
  if (!work.needsShape) return submission;
  const shape = await submitCurrentShape(raw, work.epoch, budget, failures);
  return {
    ...submission,
    shape: shape.outcome,
    status: shape.status === 200 ? submission.status : shape.status,
  };
}

/** Builds the Shapley input, queues the sweep, then warms the baseline. */
async function submitSweep(
  raw: RawSnapshot,
  work: CurrentEpochWork,
  budget: WorkBudget,
  failures: FailureLog,
): Promise<SweepSubmission> {
  let operators: number | undefined;
  try {
    const built = buildCanonicalShapleyInput(raw);
    if (!built.canonical) {
      throw new JobStartError(
        `epoch ${work.epoch}: Shapley input unavailable (${built.reason ?? "unknown"})`,
        422,
      );
    }
    operators = parseSnapshot(raw).contributors.filter(
      (contributor) => contributor.linkCount > 0,
    ).length;
    const sweep = await startLinkEstimateSweep(
      built.input,
      work.tag,
      budget.callOptions(),
    );
    const baseline = await warmBaseline(built.input, budget, failures);
    return {
      sweep: "accepted",
      sweepJobId: sweep.job_id,
      operators,
      baseline,
      status: 200,
    };
  } catch (error) {
    return {
      sweep: "failed",
      operators,
      status: failures.record("current-sweep", error).status,
    };
  }
}

/** Fail-soft: the sweep is already queued, so a baseline failure is recorded, not fatal. */
async function warmBaseline(
  input: ShapleyInput,
  budget: WorkBudget,
  failures: FailureLog,
): Promise<BaselineOutcome> {
  try {
    return await startBaselinePrecompute(input, budget.callOptions());
  } catch (error) {
    return { error: failures.record("baseline-warm", error).message };
  }
}

interface ShapeSubmission {
  outcome: ShapeOutcome;
  /** 200 unless the write failed. */
  status: number;
}

async function submitCurrentShape(
  raw: RawSnapshot,
  epoch: number,
  budget: WorkBudget,
  failures: FailureLog,
): Promise<ShapeSubmission> {
  try {
    const shape = extractDiffShape(raw);
    const outcome = await putDiffShape(
      epoch,
      shape,
      budget.callOptions(SHAPE_PUT_TIMEOUT_MS),
    );
    return { outcome, status: 200 };
  } catch (error) {
    return {
      outcome: "failed",
      status: failures.record("current-shape", error).status,
    };
  }
}

interface HistoryRepair {
  results: Record<number, ShapeOutcome>;
  deferred: number[];
}

/**
 * Historical repairs run after the current epoch inside their own budget. An
 * attempt starts only when its full allowance remains, so a slow download
 * cannot push the response past the function limit; the rest waits for the
 * next fire.
 */
async function repairHistory(
  targets: readonly number[],
  budget: WorkBudget,
  failures: FailureLog,
): Promise<HistoryRepair> {
  const results: Record<number, ShapeOutcome> = {};
  const deferred: number[] = [];
  const repairDeadline = Math.min(
    budget.deadline,
    budget.now() + REPAIR_WORK_TIMEOUT_MS,
  );
  for (const target of targets) {
    const remainingMs = repairDeadline - budget.now();
    if (budget.signal.aborted || remainingMs < REPAIR_ATTEMPT_TIMEOUT_MS) {
      deferred.push(target);
      continue;
    }
    try {
      results[target] = await repairShape(target, budget);
    } catch (error) {
      results[target] = "failed";
      failures.record(`shape-${target}`, error);
    }
  }
  return { results, deferred };
}

/** One download, extraction, and write inside a single attempt allowance. */
async function repairShape(
  epoch: number,
  budget: WorkBudget,
): Promise<ShapeOutcome> {
  const attemptDeadline = budget.now() + REPAIR_ATTEMPT_TIMEOUT_MS;
  const signal = boundedSignal(
    budget.callOptions(REPAIR_ATTEMPT_TIMEOUT_MS),
    REPAIR_ATTEMPT_TIMEOUT_MS,
  );
  const raw = await fetchEpochSnapshot(epoch, {
    signal,
    timeoutMs: REPAIR_ATTEMPT_TIMEOUT_MS,
  });
  budget.check(attemptDeadline);
  const shape = extractDiffShape(raw);
  budget.check(attemptDeadline);
  return putDiffShape(
    epoch,
    shape,
    budget.callOptions(attemptDeadline - budget.now(), signal),
  );
}

function buildBody(
  epoch: number,
  tag: string,
  current: CurrentEpochResult,
  history: HistoryRepair,
  errors: Record<string, string>,
): PrecomputeBody {
  const results: Record<number, ShapeOutcome> = { ...history.results };
  if (current.shape !== undefined) results[epoch] = current.shape;
  const failedEpochs = Object.entries(results)
    .filter(([, outcome]) => outcome === "failed")
    .map(([key]) => Number(key));
  const body: PrecomputeBody = {
    epoch,
    tag,
    sweep: current.sweep,
    sweep_job_id: current.sweepJobId,
    operators: current.operators,
    baseline: current.baseline,
    shapes: {
      ...results,
      deferred: history.deferred.length,
      deferred_epochs: history.deferred,
      failed_epochs: failedEpochs,
    },
  };
  if (Object.keys(errors).length > 0) body.errors = errors;
  if (current.status !== 200) body.error = "required current-epoch work failed";
  return body;
}

/**
 * One cron fire: resolve the epoch, read what is already done, do the current
 * epoch's sweep and shape from one snapshot download, then repair historical
 * shape gaps with what remains of the budget.
 */
export async function runPrecomputeIngest(
  epochParam: string | null,
  options: PrecomputeOptions = {},
): Promise<PrecomputeResult> {
  const now = options.nowMs ?? Date.now;
  const startedAtMs = options.startedAtMs ?? now();
  const budget = new WorkBudget(
    startedAtMs + CRON_WORK_TIMEOUT_MS,
    now,
    options.signal,
  );
  const failures = new FailureLog();

  const requested = epochParam === null ? null : parseEpochParam(epochParam);
  if (epochParam !== null && requested === null) {
    return {
      status: 400,
      body: {
        error: `epoch must be an integer in [${MIN_DZ_EPOCH}, ${MAX_DIFF_EPOCH}]`,
      },
    };
  }
  let epoch: number;
  try {
    epoch = requested ?? (await discoverLatestEpoch(budget));
    budget.check();
  } catch (error) {
    const failure = failures.record("discovery", error);
    return { status: failure.status, body: { error: failure.message } };
  }
  failures.epoch = epoch;
  const tag = sweepTag(epoch);

  const state = await readEpochState(epoch, tag, budget, failures);
  const schedule = scheduleDiffRepairs(
    state.missing,
    epoch,
    MAX_SHAPE_ATTEMPTS_PER_FIRE,
    Math.floor(startedAtMs / SCHEDULE_INTERVAL_MS),
  );
  const current = await runCurrentEpoch(
    {
      epoch,
      tag,
      isSwept: state.isSwept,
      needsShape: schedule.selected.includes(epoch),
    },
    budget,
    failures,
  );
  const history = await repairHistory(
    schedule.selected.filter((candidate) => candidate !== epoch),
    budget,
    failures,
  );
  const body = buildBody(
    epoch,
    tag,
    current,
    {
      results: history.results,
      deferred: [...schedule.deferred, ...history.deferred],
    },
    failures.errors,
  );
  return { status: current.status, body };
}
