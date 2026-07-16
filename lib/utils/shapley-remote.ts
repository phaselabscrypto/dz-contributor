import {
  SHAPLEY_SERVICE_URL,
  shapleyEndpointUrl,
  shapleyServiceBase,
} from "@/lib/constants/config";
import type { ShapleyInput, ShapleyOutput } from "@/lib/types/shapley";
import { reportError } from "@/lib/observability";

/**
 * Single source of truth for talking to the Rust Shapley microservice
 * (network-shapley-rs HTTP wrapper, deployed to Cloud Run / Fly / etc.).
 *
 * Two modes:
 *   - `computeShapleyRemote(input)`: throws on misconfiguration or HTTP
 *     failure. Callers that want canonical-or-bust use this.
 *   - `tryComputeShapleyRemote(input)`: returns null on any failure
 *     (missing URL, network error, non-2xx). Callers that gracefully
 *     fall back to the TS solver use this.
 */

const DEFAULT_METHOD = "lp-multi-commodity-flow-rs";
const TIMEOUT_MS = 180_000;

// Service-side cancel is an idempotent Redis flag write, so retry it a few
// times to be sure it lands even through a transient blip rather than
// silently dropping a cancel and leaving the worker computing.
const CANCEL_MAX_ATTEMPTS = 3;
const CANCEL_RETRY_DELAY_MS = 400;

/** Server-side bearer token for the Rust service (never exposed to clients). */
const API_TOKEN = process.env.SHAPLEY_API_TOKEN;

/** Request headers, including the bearer token when configured. */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_TOKEN) headers["Authorization"] = `Bearer ${API_TOKEN}`;
  return headers;
}

/** Wire format returned by the Rust service's POST /shapley endpoint. */
interface RustShapleyResponse {
  method: string;
  operator_count: number;
  values: Record<string, { value: number; share: number }>;
}

export interface ShapleyRemoteResult {
  output: ShapleyOutput;
  method: string;
}

function decodeResponse(data: RustShapleyResponse): ShapleyRemoteResult {
  const output: ShapleyOutput = {};
  for (const [op, v] of Object.entries(data.values)) {
    output[op] = { value: v.value, share: v.share };
  }
  return { output, method: data.method ?? DEFAULT_METHOD };
}

/**
 * Typed failure from the Rust Shapley `/shapley` call: carries the upstream
 * HTTP status (when a response arrived) and whether the failure was a
 * client-side timeout. The baseline route's 202-warming vs 502 split hangs
 * off these fields — see `ShapleyServiceError` in `epoch-shapley.ts`.
 */
export class RemoteSolveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly timedOut: boolean = false,
    cause?: unknown,
  ) {
    super(message);
    this.name = "RemoteSolveError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Upstream error bodies get truncated to this length: a HAProxy/OpenShift
 * 504 page is kilobytes of HTML that would otherwise flood logs/Sentry.
 */
const MAX_ERROR_DETAIL_CHARS = 500;

/**
 * Call the Rust Shapley service. Throws if `SHAPLEY_SERVICE_URL` is
 * unset; throws `RemoteSolveError` if the request times out client-side
 * or the response is not 2xx. The thrown error message is intentionally
 * specific so the caller can log the underlying cause without re-wrapping.
 *
 * `timeoutMs` defaults to 180s — callers running inside a smaller function
 * budget (e.g. `maxDuration = 60` routes) MUST pass a timeout below that
 * budget, or the platform kills the function into a raw 504 before this
 * abort can produce the typed timeout error.
 */
export async function computeShapleyRemote(
  input: ShapleyInput,
  opts: { timeoutMs?: number } = {},
): Promise<ShapleyRemoteResult> {
  const url = shapleyEndpointUrl("/shapley");
  if (!url) {
    throw new Error(
      "SHAPLEY_SERVICE_URL not configured. Set it in Vercel " +
        "(vercel env add SHAPLEY_SERVICE_URL production) to point at " +
        "the deployed network-shapley-rs service. Without it, routes " +
        "fall back to the local TS heuristic in lib/utils/shapley-solver.ts.",
    );
  }

  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout yields TimeoutError on current Node, AbortError on
    // older lines (same two-name check as app/api/health/route.ts). Network
    // failures (undici TypeError) pass through untyped → classified as hard.
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      throw new RemoteSolveError(
        `Rust Shapley service timed out after ${timeoutMs}ms`,
        undefined,
        true,
        err,
      );
    }
    throw err;
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(
      0,
      MAX_ERROR_DETAIL_CHARS,
    );
    throw new RemoteSolveError(
      `Rust Shapley service HTTP ${response.status}` +
        (detail ? `: ${detail}` : ""),
      response.status,
    );
  }

  const data = (await response.json()) as RustShapleyResponse;
  return decodeResponse(data);
}

/**
 * Soft-failure variant: returns null on any error (missing URL, network
 * failure, non-2xx response). Use this when the caller falls back to a
 * different solver path and never wants the request to abort.
 *
 * The error reason is intentionally NOT returned — if a caller needs to
 * distinguish failure modes, use `computeShapleyRemote` and catch.
 */
export async function tryComputeShapleyRemote(
  input: ShapleyInput,
): Promise<ShapleyRemoteResult | null> {
  if (!SHAPLEY_SERVICE_URL) return null;
  try {
    return await computeShapleyRemote(input);
  } catch (err) {
    // Soft-failure path: the error is intentionally not propagated to
    // the caller (which renders a skip / fallback marker in its UI),
    // but we still log it so the failure surfaces in observability —
    // no silent swallowing rule (#19).
    reportError(err, {
      source: "lib/utils/shapley-remote#tryComputeShapleyRemote",
    });
    return null;
  }
}

// ── /simulate endpoint ──────────────────────────────────────────────

/** Wire format returned by the Rust service's POST /simulate endpoint. */
interface RustSimulateResponse {
  baseline: RustShapleyResponse;
  modified: RustShapleyResponse;
  stats: {
    baseline_cache_hit: boolean;
    coalitions_reused: number;
    coalitions_solved: number;
    baseline_ms: number;
    modified_ms: number;
  };
}

export interface SimulateRemoteResult {
  baseline: ShapleyRemoteResult;
  modified: ShapleyRemoteResult;
  stats: RustSimulateResponse["stats"];
}

/**
 * Call the Rust service's `/simulate` endpoint, which computes both
 * baseline and modified Shapley values in one shot, reusing coalition
 * values from the baseline for the modified run.
 *
 * This is dramatically faster than two separate `/shapley` calls because
 * the modified run reuses ~75% of already-solved coalitions.
 */
export async function simulateShapleyRemote(
  baseline: ShapleyInput,
  modified: ShapleyInput,
): Promise<SimulateRemoteResult> {
  const url = shapleyEndpointUrl("/simulate");
  if (!url) {
    throw new Error(
      "SHAPLEY_SERVICE_URL not configured. Cannot call /simulate.",
    );
  }

  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ baseline, modified }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Rust Shapley /simulate HTTP ${response.status}` +
        (detail ? `: ${detail}` : ""),
    );
  }

  const data = (await response.json()) as RustSimulateResponse;
  return {
    baseline: decodeResponse(data.baseline),
    modified: decodeResponse(data.modified),
    stats: data.stats,
  };
}

// ── Async job API (start / poll / cancel) ───────────────────────────────
//
// The Rust service runs the modified solve in the background with a cancel
// flag + live progress counters. These helpers (server-side only — they carry
// the bearer token) start a job, poll it, and cancel it. The Next.js job
// routes proxy these so the browser can drive a progress bar + cancel button.

/** State + progress of an async simulate job (mirrors Rust `GET /jobs/{id}`). */
export interface SimulateJobStatus {
  state: "running" | "done" | "failed" | "cancelled";
  progress?: {
    coalitions_solved: number;
    samples_done: number;
    max_samples: number;
    percent: number;
  };
  result?: SimulateRemoteResult;
  error?: string;
}

function jobsBase(): string {
  const base = shapleyServiceBase();
  if (!base) throw new Error("SHAPLEY_SERVICE_URL not configured.");
  return base;
}

/** Start a background what-if job. Returns the job id to poll. */
export async function startSimulateJob(
  baseline: ShapleyInput,
  modified: ShapleyInput,
): Promise<string> {
  const response = await fetch(`${jobsBase()}/jobs/simulate`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ baseline, modified }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `start job HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const data = (await response.json()) as { job_id: string };
  return data.job_id;
}

/** Poll a job's status/progress (decoding the result when it's done). */
export async function getSimulateJob(jobId: string): Promise<SimulateJobStatus> {
  const response = await fetch(
    `${jobsBase()}/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "GET",
      headers: buildHeaders(),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) {
    return { state: "failed", error: "job not found (expired?)" };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `job status HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const raw = (await response.json()) as {
    state: SimulateJobStatus["state"];
    progress?: SimulateJobStatus["progress"];
    result?: RustSimulateResponse;
    error?: string;
  };
  return {
    state: raw.state,
    progress: raw.progress,
    error: raw.error,
    result: raw.result
      ? {
          baseline: decodeResponse(raw.result.baseline),
          modified: decodeResponse(raw.result.modified),
          stats: raw.result.stats,
        }
      : undefined,
  };
}

/**
 * Request cancellation of a running job. The service-side cancel is an
 * idempotent Redis flag write, so we retry a few times to be sure it lands
 * through a transient blip instead of silently leaving the worker computing.
 * Returns true once the service acknowledges (or the job is already gone),
 * false if every attempt failed.
 */
export async function cancelSimulateJob(jobId: string): Promise<boolean> {
  const url = `${jobsBase()}/jobs/${encodeURIComponent(jobId)}`;
  for (let attempt = 1; attempt <= CANCEL_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: buildHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
      // ok = cancel flag written; 404 = job already done/expired/unknown, so
      // there's nothing left to cancel — either way we're done retrying.
      if (res.ok || res.status === 404) return true;
    } catch {
      // network error / timeout — fall through to retry
    }
    if (attempt < CANCEL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, CANCEL_RETRY_DELAY_MS * attempt));
    }
  }
  reportError(
    new Error(`cancel failed after ${CANCEL_MAX_ATTEMPTS} attempts`),
    { source: "lib/utils/shapley-remote#cancelSimulateJob", extras: { jobId } }
  );
  return false;
}

// ── Link-estimate async job API ─────────────────────────────────────────
//
// Per-link Shapley value-add for a focus operator (faithful retag-Shapley port
// of Python `network_linkestimate`). Same job lifecycle as `/jobs/simulate`;
// `cancelSimulateJob` is job-id-based and works for either kind.

/**
 * One scored link from the Rust service — the SINGLE TS declaration of this
 * wire shape (route handlers and the page import it; duplicating it is how the
 * sync route's copy went stale when `index` was removed).
 *
 * `percent` is a 0–1 fraction of the positive value total (NOT 0–100); the
 * page recomputes its display % from `value`, so treat `percent` as
 * informational. `value` is signed — negatives mean "no positive contribution".
 */
export interface LinkEstimateLink {
  device1: string;
  device2: string;
  bandwidth: number;
  latency: number;
  value: number;
  percent: number;
}

/** Wire format of the Rust service's link-estimate result. */
export interface LinkEstimateResult {
  method: string;
  operator_focus: string;
  links: LinkEstimateLink[];
}

/** State + progress of an async link-estimate job (Rust `GET /jobs/{id}`). */
export interface LinkEstimateJobStatus {
  state: "running" | "done" | "failed" | "cancelled";
  progress?: {
    percent: number;
    coalitions_solved?: number;
    coalitions_total?: number;
  };
  result?: LinkEstimateResult;
  error?: string;
}

/**
 * Job submission failure carrying the upstream HTTP status, so proxy routes can
 * propagate it instead of collapsing everything to 500. The distinction is
 * load-bearing: the Rust service's 503 means "async jobs disabled (no Redis)"
 * and must surface as a 503, not masquerade as an internal error.
 */
export class JobStartError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JobStartError";
  }
}

/** One operator's enqueue record in a sweep job's summary. */
export interface SweepEnqueued {
  operator: string;
  job_id: string;
}

/** One operator's skip record in a sweep job's summary. */
export interface SweepSkipped {
  operator: string;
  reason: string;
}

/**
 * Terminal `result` of a sweep job (read via `GET /jobs/{sweep_job_id}`) —
 * fully transparent: every operator lands in exactly one of these buckets,
 * nothing is silently dropped.
 */
export interface LinkEstimateSweepSummary {
  enqueued: SweepEnqueued[];
  cached: string[];
  skipped: SweepSkipped[];
  already_running: { operator: string; job_id: string | null }[];
  failed: { operator: string; error: string }[];
  marker_written: boolean;
  tag: string | null;
}

/**
 * Kick off the epoch precompute sweep as a QUEUED job: the service stores the
 * epoch input once, enqueues a single sweep job, and returns `202 {job_id}`
 * in well under a second — the per-operator expansion happens on a worker
 * (the old synchronous sweep held the socket through O(operators) S3 + Redis
 * round-trips and was killed at ~30s by the cluster router). Poll
 * `GET /jobs/{job_id}` for the {@link LinkEstimateSweepSummary}.
 *
 * The operator set is deliberately NOT sent: the service derives the complete
 * set from the input's devices (0-link operators land in `skipped`), and only
 * service-derived sweeps may write the "fully swept" marker — an explicit
 * (possibly partial) list carrying the canonical tag would otherwise mark the
 * epoch complete and stop the cron from ever sweeping the remainder.
 *
 * `tag` keys that S3 marker (see {@link getSweepStatus}); pass the same tag on
 * every fire for an epoch. The 15s timeout is deliberate: this is an enqueue
 * now — if even that is slow, something is wrong and we want the cron log to
 * say so.
 */
export async function startLinkEstimateSweep(
  input: ShapleyInput,
  tag: string,
): Promise<{ job_id: string }> {
  const response = await fetch(`${jobsBase()}/precompute/link-estimates`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ input, tag }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new JobStartError(
      `link-estimate sweep HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  return (await response.json()) as { job_id: string };
}

/**
 * Whether the "fully swept" marker exists for this tag. The cron route checks
 * this FIRST and skips the 70MB snapshot fetch + canonical build entirely on
 * steady-state fires (epochs are immutable, so the marker never goes stale).
 */
export async function getSweepStatus(
  tag: string,
): Promise<{ complete: boolean; tag: string }> {
  const response = await fetch(
    `${jobsBase()}/precompute/link-estimates/status?tag=${encodeURIComponent(tag)}`,
    {
      method: "GET",
      headers: buildHeaders(),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `sweep status HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as { complete: boolean; tag: string };
}

/**
 * Warm the epoch's BASELINE cache (the what-if simulator / per-city reward
 * path) as a queued job: `200 already-cached` or `202 {job_id}`. Replaces
 * nothing client-side — `POST /precompute` previously fire-and-forgot on the
 * API pod; it now runs on the worker pool with a pollable job id.
 */
export async function startBaselinePrecompute(input: ShapleyInput): Promise<{
  status: "already-cached" | "accepted";
  job_id?: string;
  input_hash: string;
}> {
  const response = await fetch(`${jobsBase()}/precompute`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new JobStartError(
      `baseline precompute HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  return (await response.json()) as {
    status: "already-cached" | "accepted";
    job_id?: string;
    input_hash: string;
  };
}

/** Start a background link-estimate job. Returns the job id to poll. */
export async function startLinkEstimateJob(
  input: ShapleyInput,
  operatorFocus: string,
): Promise<string> {
  const response = await fetch(`${jobsBase()}/jobs/link-estimate`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ input, operator_focus: operatorFocus }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new JobStartError(
      `start link-estimate job HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  const data = (await response.json()) as { job_id: string };
  return data.job_id;
}

/** Poll a link-estimate job's status/progress (with the result when done). */
export async function getLinkEstimateJob(
  jobId: string,
): Promise<LinkEstimateJobStatus> {
  const response = await fetch(
    `${jobsBase()}/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "GET",
      headers: buildHeaders(),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) {
    return { state: "failed", error: "job not found (expired?)" };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `link-estimate job status HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const raw = (await response.json()) as {
    state: LinkEstimateJobStatus["state"];
    progress?: LinkEstimateJobStatus["progress"];
    result?: LinkEstimateResult;
    error?: string;
  };
  return {
    state: raw.state,
    progress: raw.progress,
    error: raw.error,
    result: raw.result,
  };
}
