"use client";

import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

/** The raw stored string, or null when absent, unreadable, or server-side. */
export function readStoredRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage blocked (private mode, disabled site data). Treat as absent.
    return null;
  }
}

/**
 * Decode a stored string, falling back whenever it is absent, null,
 * unparseable, or rejected by `validate`. Never throws, never reads storage.
 */
export function parseStored<T>(
  raw: string | null,
  fallback: T,
  validate?: (parsed: unknown) => T | null,
): T {
  if (raw === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A stale or hand-edited entry is expected here, so swallow and fall back.
    return fallback;
  }
  if (parsed === null) return fallback;
  if (validate) return validate(parsed) ?? fallback;
  return parsed as T;
}

/**
 * useState that mirrors itself to localStorage, SSR-safe and shared across
 * every component reading the same key. When storage refuses a write the value
 * is held in memory for the session instead, so the control still responds.
 * Pass `validate` to reject a stored value that does not fit `T`, and hoist it
 * and `initial` to module scope so the returned value keeps a stable identity
 * across renders.
 */
export function useLocalStorageState<T>(
  key: string,
  initial: T,
  validate?: (parsed: unknown) => T | null,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [override, setOverride] = useState<{ value: T } | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined") return () => {};
      const handler = (e: StorageEvent) => {
        // A clear() in another tab reports a null key and drops every entry.
        if (e.key === key || e.key === null) onStoreChange();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
    [key],
  );

  // The snapshot stays the raw string. useSyncExternalStore compares snapshots
  // with Object.is, so a freshly parsed object never compares equal and
  // re-renders until React throws.
  const getSnapshot = useCallback(
    (): string | null => readStoredRaw(key),
    [key],
  );
  const getServerSnapshot = useCallback((): string | null => null, []);

  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const stored = useMemo(
    () => parseStored(raw, initial, validate),
    [raw, initial, validate],
  );
  const value = override ? override.value : stored;

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = override
        ? override.value
        : parseStored(readStoredRaw(key), initial, validate);
      const resolved =
        typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      const serialized = JSON.stringify(resolved);
      try {
        window.localStorage.setItem(key, serialized);
      } catch {
        // Storage refused the write, so hold the value for this session only.
        setOverride({ value: resolved });
        return;
      }
      setOverride(null);
      // `storage` only fires in other tabs; dispatch so this one re-reads too.
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: serialized }),
      );
    },
    [key, initial, validate, override],
  );

  return [value, set];
}
