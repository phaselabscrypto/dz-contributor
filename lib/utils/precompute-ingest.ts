import { MIN_DZ_EPOCH, SNAPSHOT_FETCH_TIMEOUT_MS } from "@/lib/constants/config";
import { reportError } from "@/lib/observability";
import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import { extractDiffShape } from "@/lib/utils/diff-shape";
import { MAX_DIFF_EPOCH } from "@/lib/utils/diff-window";
import { scheduleDiffRepairs } from "@/lib/utils/diff-repair-schedule";
import { getEpochAvailability } from "@/lib/utils/epoch-discovery";
import { EpochSnapshotError, fetchEpochSnapshot } from "@/lib/utils/epoch-snapshot";
import { boundedSignal, type RequestDeadline } from "@/lib/utils/request-deadline";
import { JobStartError, fetchMissingDiffShapes, getSweepStatus, putDiffShape, startBaselinePrecompute, startLinkEstimateSweep } from "@/lib/utils/shapley-remote";
import { parseSnapshot } from "@/lib/utils/snapshot-parser";
import { sweepTag } from "@/lib/utils/sweep-tag";

export const CRON_WORK_TIMEOUT_MS = 270_000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 12_000;
const REPAIR_WORK_TIMEOUT_MS = 90_000;
const REPAIR_ATTEMPT_TIMEOUT_MS = 40_000;
const MAX_SHAPE_ATTEMPTS_PER_FIRE = 3;
const DIFF_REPAIR_DEPTH = 31;
const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;

type ShapeOutcome = "created" | "exists" | "failed";
interface PrecomputeBody {
  epoch?: number;
  tag?: string;
  sweep?: "already-swept" | "accepted" | "failed";
  sweep_job_id?: string;
  operators?: number;
  baseline?: Awaited<ReturnType<typeof startBaselinePrecompute>> | { error: string };
  shapes?: Record<number, ShapeOutcome> & { deferred: number; deferred_epochs: number[]; failed_epochs: number[] };
  errors?: Record<string, string>;
  error?: string;
}
interface PrecomputeResult { status: number; body: PrecomputeBody }

function safeFailure(error: unknown): { message: string; status: number } {
  if (error instanceof JobStartError) return { message: error.message, status: error.status };
  if (error instanceof EpochSnapshotError) {
    const status = error.category === "timeout" || error.category === "aborted" ? 504
      : error.category === "epoch-mismatch" || error.category === "envelope" || error.category === "json" ? 422
        : error.status === 404 ? 404 : 502;
    return { message: error.message, status };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { message: "precompute work timed out or aborted", status: 504 };
  }
  return { message: "precompute work failed", status: 502 };
}

export async function runPrecomputeIngest(epochParam: string | null, options: { signal?: AbortSignal; startedAtMs?: number; nowMs?: () => number } = {}): Promise<PrecomputeResult> {
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = options.startedAtMs ?? nowMs();
  const deadline = startedAtMs + CRON_WORK_TIMEOUT_MS;
  const signal = boundedSignal({ signal: options.signal, timeoutMs: Math.max(1, deadline - nowMs()) }, CRON_WORK_TIMEOUT_MS);
  const body: PrecomputeBody = {};
  const errors: Record<string, string> = {};
  function checkDeadline(until = deadline): void {
    if (signal.aborted || nowMs() >= Math.min(deadline, until)) throw new JobStartError("precompute work deadline exceeded", 504);
  }
  function callOptions(timeoutMs = 15_000, parentSignal = signal): RequestDeadline {
    checkDeadline();
    parentSignal.throwIfAborted();
    return { signal: parentSignal, timeoutMs: Math.min(timeoutMs, deadline - nowMs()) };
  }
  function recordFailure(phase: string, error: unknown): { message: string; status: number } {
    reportError(error, { source: "api/link-value/precompute", extras: { epoch: body.epoch, phase } });
    const failure = safeFailure(error);
    errors[phase] = failure.message;
    return failure;
  }

  let epoch: number;
  try {
    if (epochParam !== null) {
      epoch = /^[+-]?\d+$/.test(epochParam.trim()) ? Number(epochParam) : NaN;
      if (!Number.isInteger(epoch) || epoch < MIN_DZ_EPOCH || epoch > MAX_DIFF_EPOCH) {
        return { status: 400, body: { error: `epoch must be an integer in [${MIN_DZ_EPOCH}, ${MAX_DIFF_EPOCH}]` } };
      }
    } else {
      epoch = (await getEpochAvailability(false, { signal: boundedSignal(callOptions(DISCOVERY_TIMEOUT_MS), DISCOVERY_TIMEOUT_MS) })).latest;
    }
    checkDeadline();
  } catch (error) {
    const failure = recordFailure("discovery", error);
    return { status: failure.status, body: { error: failure.message } };
  }
  body.epoch = epoch;
  const tag = sweepTag(epoch);
  body.tag = tag;
  const [sweepCheck, missingCheck] = await Promise.allSettled([
    (async () => getSweepStatus(tag, callOptions(STATUS_TIMEOUT_MS)))(),
    (async () => fetchMissingDiffShapes(epoch, DIFF_REPAIR_DEPTH, callOptions(STATUS_TIMEOUT_MS)))(),
  ]);
  const isSwept = sweepCheck.status === "fulfilled" && sweepCheck.value.complete;
  if (sweepCheck.status === "rejected") recordFailure("marker-check", sweepCheck.reason);
  const missing = missingCheck.status === "fulfilled" ? missingCheck.value : [epoch];
  if (missingCheck.status === "rejected") recordFailure("missing-shapes", missingCheck.reason);
  const schedule = scheduleDiffRepairs(missing, epoch, MAX_SHAPE_ATTEMPTS_PER_FIRE, Math.floor(startedAtMs / SCHEDULE_INTERVAL_MS));
  const shapeResults: Record<number, ShapeOutcome> = {};
  const deferred = [...schedule.deferred];
  let currentStatus = 200;
  body.sweep = isSwept ? "already-swept" : "failed";
  const needsCurrentShape = schedule.selected.includes(epoch);

  if (!isSwept || needsCurrentShape) {
    try {
      const raw = await fetchEpochSnapshot(epoch, callOptions(SNAPSHOT_FETCH_TIMEOUT_MS));
      checkDeadline();
      if (!isSwept) {
        try {
          const built = buildCanonicalShapleyInput(raw);
          if (!built.canonical) throw new JobStartError(`epoch ${epoch}: canonical input unavailable (${built.reason ?? "unknown"})`, 422);
          body.operators = parseSnapshot(raw).contributors.filter(contributor => contributor.linkCount > 0).length;
          const sweep = await startLinkEstimateSweep(built.input, tag, callOptions());
          body.sweep = "accepted";
          body.sweep_job_id = sweep.job_id;
          try { body.baseline = await startBaselinePrecompute(built.input, callOptions()); }
          catch (error) { body.baseline = { error: recordFailure("baseline-warm", error).message }; }
        } catch (error) { currentStatus = recordFailure("current-sweep", error).status; }
      }
      if (needsCurrentShape) {
        try {
          const shape = extractDiffShape(raw);
          shapeResults[epoch] = await putDiffShape(epoch, shape, callOptions(30_000));
        } catch (error) {
          shapeResults[epoch] = "failed";
          currentStatus = recordFailure("current-shape", error).status;
        }
      }
    } catch (error) {
      currentStatus = recordFailure("current-snapshot", error).status;
      if (needsCurrentShape) shapeResults[epoch] = "failed";
    }
  }

  // The current raw snapshot is out of scope before a historical download starts.
  const repairDeadline = Math.min(deadline, nowMs() + REPAIR_WORK_TIMEOUT_MS);
  for (const target of schedule.selected.filter(candidate => candidate !== epoch)) {
    if (signal.aborted || repairDeadline - nowMs() < REPAIR_ATTEMPT_TIMEOUT_MS) {
      deferred.push(target);
      continue;
    }
    const attemptDeadline = nowMs() + REPAIR_ATTEMPT_TIMEOUT_MS;
    try {
      const attemptSignal = boundedSignal(callOptions(REPAIR_ATTEMPT_TIMEOUT_MS), REPAIR_ATTEMPT_TIMEOUT_MS);
      const raw = await fetchEpochSnapshot(target, { signal: attemptSignal, timeoutMs: REPAIR_ATTEMPT_TIMEOUT_MS });
      checkDeadline(attemptDeadline);
      const shape = extractDiffShape(raw);
      checkDeadline(attemptDeadline);
      shapeResults[target] = await putDiffShape(target, shape, callOptions(attemptDeadline - nowMs(), attemptSignal));
    } catch (error) {
      shapeResults[target] = "failed";
      recordFailure(`shape-${target}`, error);
    }
  }
  body.shapes = { ...shapeResults, deferred: deferred.length, deferred_epochs: deferred, failed_epochs: Object.entries(shapeResults).filter(([, outcome]) => outcome === "failed").map(([key]) => Number(key)) };
  if (Object.keys(errors).length > 0) body.errors = errors;
  if (currentStatus !== 200) body.error = "required current-epoch work failed";
  return { status: currentStatus, body };
}
