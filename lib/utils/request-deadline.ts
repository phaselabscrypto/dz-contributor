export interface RequestDeadline {
  /** Aborts the call early, on top of the timeout. */
  signal?: AbortSignal;
  /** Overrides the call's default timeout. */
  timeoutMs?: number;
}

/** Fires on the caller's signal or after the timeout, whichever comes first. */
export function boundedSignal(
  options: RequestDeadline,
  defaultTimeoutMs: number,
): AbortSignal {
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? defaultTimeoutMs),
  );
  const timeout = AbortSignal.timeout(timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}
