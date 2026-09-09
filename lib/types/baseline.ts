import type { ShapleyOutput } from "@/lib/types/shapley";

/**
 * Wire contracts of the cache-only baseline surface: `GET /api/shapley/baseline`,
 * `GET /api/shapley?epoch=N` and `GET /api/shapley/tracking?count=N`. Declared
 * once here so routes, hooks, components and scripts cannot drift apart.
 */

/** 200 body of GET /api/shapley/baseline and GET /api/shapley?epoch=N. */
export interface EpochBaseline {
  epoch: number;
  tag: string;
  method: string;
  operatorCount: number;
  values: ShapleyOutput;
  fetchedAt: string;
}

/** 404 body: the cron has not published this epoch. */
export interface BaselineNotCached {
  status: "not-cached";
  epoch: number;
  tag: string;
}

export type BaselineResponse = EpochBaseline | BaselineNotCached;

export interface ShapleyTrackingPoint {
  epoch: number;
  share: number;
  value: number;
}

export interface ShapleyTrackingOperator {
  operator: string;
  series: ShapleyTrackingPoint[];
  latestShare: number;
  delta: number;
  stdev: number;
}

/** 200 body of GET /api/shapley/tracking?count=N; `epochs` has at least two entries. */
export interface ShapleyTracking {
  epochs: number[];
  missingEpochs: number[];
  method: string;
  operators: ShapleyTrackingOperator[];
  fetchedAt: string;
}

/** 404 body: fewer than two of the requested epochs are cached. */
export interface TrackingNotCached {
  status: "not-cached";
  epochs: number[];
  missingEpochs: number[];
}

export type TrackingResponse = ShapleyTracking | TrackingNotCached;

export type NotCached = BaselineNotCached | TrackingNotCached;

/** Runtime check; accepts unknown so fetchers can test a parsed 404 body. */
export function isNotCached(value: unknown): value is NotCached {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "not-cached"
  );
}

export function cachedBaseline(
  body: BaselineResponse | undefined,
): EpochBaseline | null {
  return body !== undefined && !isNotCached(body) ? body : null;
}

export function cachedTracking(
  body: TrackingResponse | undefined,
): ShapleyTracking | null {
  return body !== undefined && !isNotCached(body) ? body : null;
}
