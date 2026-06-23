/**
 * Health probe types — shared between the `/api/health` server route
 * and the `useHealth` client hook. Defined here so the wire shape
 * lives in exactly one place (the review flagged drift risk between
 * the two copies).
 */

/** Categorized failure mode. Never includes URL/path/token text. */
export type SourceErrorCode = "timeout" | "network" | "parse" | "unknown";

/** Single upstream probe result. `host` is hostname-only — never a
 *  full URL with path/query/credentials. */
export interface SourceHealth {
  /** Public identifier (e.g. "malbec/topology"). */
  name: string;
  /** Hostname of the upstream, with no path/query/credentials. */
  host: string;
  status: "ok" | "degraded" | "down" | "disabled";
  latencyMs: number | null;
  httpStatus?: number;
  errorCode?: SourceErrorCode;
}

export interface HealthAggregate {
  overall: "ok" | "degraded" | "down";
  checkedAt: string;
  sources: SourceHealth[];
}
