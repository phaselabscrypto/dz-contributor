import {
  MIN_DZ_EPOCH,
  shapleyEndpointUrl,
  shapleyServiceBase,
} from "@/lib/constants/config";
import type { BaselineVariant } from "@/lib/types/baseline";
import { isNotCached } from "@/lib/types/baseline";
import type { DiffShapeRecord } from "@/lib/types/diff";
import type { ShapleyInput, ShapleyOutput } from "@/lib/types/shapley";
import { reportError } from "@/lib/observability";
import {
  boundedSignal,
  type RequestDeadline,
} from "@/lib/utils/request-deadline";

/**
 * Single source of truth for talking to the Rust Shapley microservice
 * (network-shapley-rs HTTP wrapper, deployed to Cloud Run / Fly / etc.).
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
/**
 * Second token, required ON TOP of `SHAPLEY_API_TOKEN` on the ingest routes.
 * Separate because writing a record every reader is then served is a different
 * power from asking for a compute. Unset means the service answers 503.
 */
const INGEST_TOKEN = process.env.SHAPLEY_INGEST_TOKEN;

/** Headers for a write to the ingest routes: both tokens, never logged. */
function buildIngestHeaders(): Record<string, string> {
  if (!INGEST_TOKEN) {
    throw new JobStartError("SHAPLEY_INGEST_TOKEN not configured", 503);
  }
  const headers = buildHeaders();
  headers["X-Ingest-Token"] = INGEST_TOKEN;
  return headers;
}

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
 * client-side timeout.
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
        "the deployed network-shapley-rs service.",
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

/** Timing and reuse telemetry the Rust service attaches to a finished simulate. */
export type SimulateStatsWire = RustSimulateResponse["stats"];

/**
 * Live counters the Rust job store emits while a job runs (mirrors the
 * `progress` object built in `jobs.rs::snapshot`). `percent` is per phase
 * (0-99) and `coalitions_total` is the phase's denominator, so a client can
 * derive a rate from `coalitions_solved` across polls.
 */
export interface SimulateJobProgress {
  /** "baseline" while the baseline solves, "modified" for the what-if, null before pickup. */
  phase?: string | null;
  coalitions_solved?: number;
  coalitions_total?: number;
  samples_done?: number;
  max_samples?: number;
  batch_samples?: number;
  batch_total?: number;
  batch_solved?: number;
  percent: number;
}

/** State + progress of an async simulate job (mirrors Rust `GET /jobs/{id}`). */
export interface SimulateJobStatus {
  state: "running" | "done" | "failed" | "cancelled";
  progress?: SimulateJobProgress;
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
  /** The service's own response text, truncated, for the server-side log only. */
  readonly detail?: string;

  constructor(
    message: string,
    readonly status: number,
    options: { cause?: unknown; detail?: string } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "JobStartError";
    this.detail = options.detail;
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

interface PrecomputeResponse {
  status: number;
  text: string;
}

/**
 * One call to the service's precompute surface under a deadline. The thrown
 * message is fixed because it can reach a response body; the connection
 * error travels as the cause, for the log.
 */
async function precomputeRequest(
  path: string,
  init: RequestInit,
  options: RequestDeadline,
  defaultTimeoutMs = 15_000,
): Promise<PrecomputeResponse> {
  const signal = boundedSignal(options, defaultTimeoutMs);
  try {
    signal.throwIfAborted();
    const response = await fetch(`${jobsBase()}${path}`, { ...init, signal });
    const text = await response.text();
    signal.throwIfAborted();
    return { status: response.status, text };
  } catch (error) {
    if (error instanceof JobStartError) throw error;
    if (signal.aborted) {
      throw new JobStartError(
        "precompute service request timed out or aborted",
        504,
        { cause: error },
      );
    }
    throw new JobStartError("precompute service unavailable", 502, {
      cause: error,
    });
  }
}

/** The JSON object body of a 2xx response; anything else is a JobStartError. */
function precomputeObject(
  response: PrecomputeResponse,
): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) {
    throw new JobStartError(
      `precompute service HTTP ${response.status}`,
      response.status,
      { detail: response.text.slice(0, 200) },
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(response.text);
  } catch (error) {
    throw new JobStartError("invalid precompute service JSON", 502, {
      cause: error,
    });
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new JobStartError("invalid precompute service response", 502);
  }
  return data as Record<string, unknown>;
}

/**
 * Enqueue the epoch sweep. The operator set is not sent: the service derives
 * the complete set, and only a derived set may publish aliases or mark the
 * epoch swept. Needs both tokens.
 */
export async function startLinkEstimateSweep(
  input: ShapleyInput,
  tag: string,
  options: RequestDeadline = {},
): Promise<{ job_id: string }> {
  const response = await precomputeRequest(
    "/precompute/link-estimates",
    {
      method: "POST",
      headers: buildIngestHeaders(),
      body: JSON.stringify({ input, tag }),
    },
    options,
  );
  const data = precomputeObject(response);
  if (typeof data.job_id !== "string" || data.job_id.length === 0) {
    throw new JobStartError("sweep response has no job ID", 502);
  }
  return { job_id: data.job_id };
}

/** Whether the "fully swept" marker exists for this tag. */
export async function getSweepStatus(
  tag: string,
  options: RequestDeadline = {},
): Promise<{ complete: boolean; tag: string }> {
  const response = await precomputeRequest(
    `/precompute/link-estimates/status?tag=${encodeURIComponent(tag)}`,
    { method: "GET", headers: buildHeaders() },
    options,
  );
  const data = precomputeObject(response);
  if (typeof data.complete !== "boolean" || data.tag !== tag) {
    throw new JobStartError("invalid sweep status response", 502);
  }
  return { complete: data.complete, tag };
}

export interface BaselinePrecompute {
  status: "already-cached" | "accepted";
  job_id?: string;
  input_hash: string;
  tag?: string;
  variant?: string;
}

/**
 * Warm the epoch's baseline as a queued job. With a `publish` target the worker
 * also writes the epoch alias when the result lands (`POST /precompute/baseline`,
 * compute + ingest tokens). With `null` it warms by input hash only
 * (`POST /precompute`), which is what the simulate variant and the link-value
 * cron want.
 */
export async function startBaselinePrecompute(
  input: ShapleyInput,
  publish: { tag: string; variant: BaselineVariant } | null,
  options: RequestDeadline = {},
): Promise<BaselinePrecompute> {
  const response = publish
    ? await precomputeRequest(
        "/precompute/baseline",
        {
          method: "POST",
          headers: buildIngestHeaders(),
          body: JSON.stringify({
            input,
            tag: publish.tag,
            variant: publish.variant,
          }),
        },
        options,
      )
    : await precomputeRequest(
        "/precompute",
        { method: "POST", headers: buildHeaders(), body: JSON.stringify(input) },
        options,
      );
  const {
    status,
    input_hash: inputHash,
    job_id: jobId,
    tag,
    variant,
  } = precomputeObject(response);
  if (status !== "already-cached" && status !== "accepted") {
    throw new JobStartError("invalid baseline response", 502);
  }
  if (
    typeof inputHash !== "string" ||
    (status === "accepted" && typeof jobId !== "string")
  ) {
    throw new JobStartError("invalid baseline response", 502);
  }
  return {
    status,
    input_hash: inputHash,
    ...(typeof jobId === "string" ? { job_id: jobId } : {}),
    ...(typeof tag === "string" ? { tag } : {}),
    ...(typeof variant === "string" ? { variant } : {}),
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

const DIFF_TIMEOUT_MS = 20_000;

/**
 * Failure talking to the service's `/diff*` endpoints: a client-side
 * timeout, a network error, or a status other than 200/400/404.
 */
export class DiffServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = "DiffServiceError";
  }
}

/** Statuses the proxies forward verbatim; anything else is a DiffServiceError. */
const DIFF_FORWARDED_STATUSES = new Set([200, 400, 404]);

/** Set by the service when attribution ran without every intermediate epoch. */
const DIFF_DEGRADED_HEADER = "x-diff-degraded";

export interface DiffUpstreamResponse {
  status: number;
  body: string;
  isDegraded: boolean;
}

async function fetchDiffPath(
  path: string,
  label: string,
  timeoutMs: number,
): Promise<DiffUpstreamResponse> {
  let response: Response;
  try {
    response = await fetch(`${jobsBase()}${path}`, {
      method: "GET",
      headers: buildHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      throw new DiffServiceError(
        `${label} timed out after ${timeoutMs}ms`,
        undefined,
        true,
      );
    }
    throw new DiffServiceError(
      `${label} request failed: ${err instanceof Error ? err.name : "unknown"}`,
    );
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    if (DIFF_FORWARDED_STATUSES.has(response.status)) {
      throw new DiffServiceError(
        `${label} body read failed: ${err instanceof Error ? err.name : "unknown"}`,
        response.status,
        err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError"),
      );
    }
    body = "";
  }
  if (!DIFF_FORWARDED_STATUSES.has(response.status)) {
    const detail = body.slice(0, MAX_ERROR_DETAIL_CHARS);
    throw new DiffServiceError(
      `${label} HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  if (!body) {
    throw new DiffServiceError(
      `${label} returned an empty body under HTTP ${response.status}`,
      response.status,
    );
  }
  return {
    status: response.status,
    body,
    isDegraded: response.headers.get(DIFF_DEGRADED_HEADER) === "1",
  };
}

/**
 * `GET {base}/diff?from&to`. Returns the upstream status and raw body so the
 * proxy can forward bytes. Throws `DiffServiceError` on timeout, an empty
 * body, or a status other than 200/400/404.
 */
export async function fetchNetworkDiffRemote(
  from: number,
  to: number,
  opts: { timeoutMs?: number } = {},
): Promise<DiffUpstreamResponse> {
  return fetchDiffPath(
    `/diff?from=${from}&to=${to}`,
    "network diff",
    opts.timeoutMs ?? DIFF_TIMEOUT_MS,
  );
}

/**
 * `GET {base}/diff/contributor/{code}?from&to`. Same contract as
 * {@link fetchNetworkDiffRemote}; the body omits `name`.
 */
export async function fetchContributorDiffRemote(
  code: string,
  from: number,
  to: number,
  opts: { timeoutMs?: number } = {},
): Promise<DiffUpstreamResponse> {
  return fetchDiffPath(
    `/diff/contributor/${encodeURIComponent(code)}?from=${from}&to=${to}`,
    "contributor diff",
    opts.timeoutMs ?? DIFF_TIMEOUT_MS,
  );
}


/**
 * Push one epoch's extracted diff record to the service. `"exists"` is a
 * normal outcome: the service verified a readable record is already there.
 */
export async function putDiffShape(
  expectedEpoch: number,
  shape: DiffShapeRecord,
  options: RequestDeadline = {},
): Promise<"created" | "exists"> {
  if (shape.epoch !== expectedEpoch) {
    throw new JobStartError(
      `epoch ${expectedEpoch}: shape epoch mismatch`,
      422,
    );
  }
  const response = await precomputeRequest(
    `/diff/shape/${expectedEpoch}`,
    {
      method: "PUT",
      headers: buildIngestHeaders(),
      body: JSON.stringify(shape),
    },
    options,
    30_000,
  );
  if (response.status === 201) return "created";
  if (response.status === 409) return "exists";
  throw new JobStartError(
    `put diff shape HTTP ${response.status}`,
    response.status,
    { detail: response.text.slice(0, 200) },
  );
}

/**
 * Epochs in `[latest - depth + 1, latest]` with no readable record. The list
 * is validated against that window so a bad response cannot steer the cron
 * at epochs it never asked about.
 */
export async function fetchMissingDiffShapes(
  latest: number,
  depth: number,
  options: RequestDeadline = {},
): Promise<number[]> {
  const response = await precomputeRequest(
    `/diff/missing?latest=${latest}&depth=${depth}`,
    { method: "GET", headers: buildHeaders() },
    options,
  );
  const { missing } = precomputeObject(response);
  const first = Math.max(MIN_DZ_EPOCH, latest - depth + 1);
  const isEpochInWindow = (epoch: unknown): epoch is number =>
    typeof epoch === "number" &&
    Number.isInteger(epoch) &&
    epoch >= first &&
    epoch <= latest;
  if (
    !Array.isArray(missing) ||
    !missing.every(isEpochInWindow) ||
    new Set(missing).size !== missing.length
  ) {
    throw new JobStartError("invalid missing-shape response", 502);
  }
  return missing;
}

/**
 * Start a link-estimate job from the precomputed `(tag, operator)` alias.
 *
 * `null` means the service has no precomputed result for this pair, which is
 * the caller's cue to take the slow path. It is NOT an error: a cold epoch, or
 * an operator over the sweep's link cap, legitimately has no alias.
 */
export async function startLinkEstimateJobByTag(
  tag: string,
  operatorFocus: string,
): Promise<string | null> {
  const response = await fetch(`${jobsBase()}/jobs/link-estimate/by-tag`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ tag, operator_focus: operatorFocus }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new JobStartError(
      `start link-estimate by tag HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  const data = (await response.json()) as { job_id: string };
  return data.job_id;
}

// ── Baseline alias probe ────────────────────────────────────────────────

/** Above the service's own 8 s bound on the S3 read, so its typed 502 wins. */
const BASELINE_PROBE_TIMEOUT_MS = 10_000;

/**
 * Failure talking to `GET /shapley/baseline`: a timeout, a network error, or a
 * status other than 200 / 404-with-`not-cached`.
 */
export class BaselineServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = "BaselineServiceError";
  }
}

export type BaselineProbe =
  | { status: "hit"; result: ShapleyRemoteResult }
  | { status: "miss" };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRustShapleyResponse(value: unknown): value is RustShapleyResponse {
  if (typeof value !== "object" || value === null) return false;
  const { method, values } = value as { method?: unknown; values?: unknown };
  return (
    typeof method === "string" &&
    typeof values === "object" &&
    values !== null &&
    !Array.isArray(values)
  );
}

/**
 * Cache-only read of one epoch's published baseline alias. 200 is a hit; a 404
 * carrying `{status:"not-cached"}` is a miss. A 404 without that body means the
 * service predates the route, so it throws like every other failure.
 */
export async function fetchBaselineByTagRemote(
  tag: string,
  options: RequestDeadline = {},
): Promise<BaselineProbe> {
  const url = `${jobsBase()}/shapley/baseline?tag=${encodeURIComponent(tag)}`;
  const signal = boundedSignal(options, BASELINE_PROBE_TIMEOUT_MS);
  let response: Response;
  let body: string;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(),
      signal,
    });
    body = await response.text();
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      throw new BaselineServiceError(
        "baseline probe timed out",
        undefined,
        true,
      );
    }
    throw new BaselineServiceError(
      `baseline probe failed: ${err instanceof Error ? err.name : "unknown"}`,
    );
  }

  if (response.status === 404) {
    if (isNotCached(parseJson(body))) return { status: "miss" };
    throw new BaselineServiceError(
      "baseline probe answered 404 without a not-cached body",
      404,
    );
  }

  if (response.status === 200) {
    const parsed = parseJson(body);
    if (!isRustShapleyResponse(parsed)) {
      throw new BaselineServiceError(
        "baseline probe returned an unexpected body",
        200,
      );
    }
    return { status: "hit", result: decodeResponse(parsed) };
  }

  const detail = body.slice(0, MAX_ERROR_DETAIL_CHARS);
  throw new BaselineServiceError(
    `baseline probe HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    response.status,
  );
}
