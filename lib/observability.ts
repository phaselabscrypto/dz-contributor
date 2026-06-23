/**
 * Observability surface — error reporting + web vitals.
 *
 * Logs to stderr/stdout in every environment (Vercel captures both into
 * function logs). When a real APM vendor (Sentry / Datadog / OpenTelemetry)
 * is wired, the swap is:
 *
 *   1. `npm i @sentry/nextjs` (or your chosen vendor)
 *   2. Set `NEXT_PUBLIC_SENTRY_DSN` in Vercel env
 *   3. In `instrumentation.ts` (created at repo root), call `Sentry.init`
 *   4. Add the vendor SDK call alongside the existing console.* calls
 *      below — keep console.* so Vercel function logs stay populated as
 *      a fallback if the vendor pipeline is degraded.
 */

interface ErrorContext {
  /** Where the error happened — route, component, API path. */
  source: string;
  /** Free-form extras: query params, user actions leading up to the error. */
  extras?: Record<string, unknown>;
}

function serializeExtras(extras: Record<string, unknown> | undefined): string {
  if (!extras || Object.keys(extras).length === 0) return "";
  try {
    return ` ${JSON.stringify(extras)}`;
  } catch {
    // Circular references etc. Don't let logging blow up.
    return " [unserializable extras]";
  }
}

/**
 * Report an unexpected error. Use sparingly — only for real exceptions
 * that indicate broken behavior, not for expected 4xx/validation errors.
 *
 * Always writes to stderr so Vercel function logs (and local dev console)
 * surface the failure.
 */
export function reportError(err: unknown, ctx: ErrorContext) {
  const message = err instanceof Error ? err.message : String(err);
  const stack =
    err instanceof Error && err.stack ? `\n${err.stack}` : "";
  console.error(
    `[obs:error] ${ctx.source}: ${message}${serializeExtras(ctx.extras)}${stack}`,
  );
  // When a real APM vendor is wired, add the SDK call here:
  //   Sentry.captureException(err, { tags: { source: ctx.source }, extra: ctx.extras });
}

/**
 * Report a noteworthy (not error) event — used by the validation harness,
 * fallback-to-TS-solver code paths, etc. Less spammy than reportError;
 * intended for "we want to see this in the dashboard but it's not broken".
 */
export function reportEvent(
  name: string,
  payload?: Record<string, unknown>,
) {
  console.info(`[obs:event] ${name}${serializeExtras(payload)}`);
  // When a real APM vendor is wired, add the SDK call here:
  //   Sentry.captureMessage(name, { level: "info", extra: payload });
}

/**
 * Web vitals shape Next.js gives us via `useReportWebVitals`.
 */
export interface WebVitalsMetric {
  id: string;
  name: string; // CLS | FCP | FID | INP | LCP | TTFB
  value: number;
  rating?: "good" | "needs-improvement" | "poor";
  delta?: number;
  navigationType?: string;
}

/**
 * Forward a web vital to /api/vitals (sampled). Called from
 * `<WebVitalsReporter>` in the root layout.
 */
export function postVitals(metric: WebVitalsMetric) {
  // 10% sample so we don't drown the endpoint.
  if (Math.random() > 0.1) return;
  if (typeof navigator === "undefined") return;
  const body = JSON.stringify({
    ...metric,
    path: window.location.pathname,
    ts: Date.now(),
  });
  // sendBeacon survives page unload; falls back to fetch if unavailable.
  if (navigator.sendBeacon) {
    navigator.sendBeacon(
      "/api/vitals",
      new Blob([body], { type: "application/json" }),
    );
    return;
  }
  fetch("/api/vitals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // never throw from a metric callback
  });
}
