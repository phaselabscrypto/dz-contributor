export interface RequestDeadline {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function boundedSignal(options: RequestDeadline, defaultTimeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(options.timeoutMs ?? defaultTimeoutMs)));
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}
