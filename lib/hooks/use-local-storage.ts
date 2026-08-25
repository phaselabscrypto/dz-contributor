"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/** The raw stored string, or null when absent, unreadable, or server-side. */
export function readStoredRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage blocked (private mode, disabled site data) — treat as absent.
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
    // Corrupt or hand-edited entry — fall back rather than propagate.
    return fallback;
  }
  if (parsed === null) return fallback;
  if (validate) return validate(parsed) ?? fallback;
  return parsed as T;
}

/**
 * useState that mirrors itself to localStorage, SSR-safe and shared across
 * every component reading the same key. A write that storage refuses has no
 * persisted effect. Pass `validate` to reject a stored value that no longer
 * fits `T`, and hoist it and `initial` to module scope so the returned value
 * keeps a stable identity across renders.
 */
export function useLocalStorageState<T>(
  key: string,
  initial: T,
  validate?: (parsed: unknown) => T | null,
): [T, (next: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined") return () => {};
      const handler = (e: StorageEvent) => {
        if (e.key === key) onStoreChange();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
    [key],
  );

  // The snapshot stays the raw string. useSyncExternalStore compares snapshots
  // with Object.is, so a freshly parsed object would never compare equal and
  // would re-render until React gives up.
  const getSnapshot = useCallback(
    (): string | null => readStoredRaw(key),
    [key],
  );
  const getServerSnapshot = useCallback((): string | null => null, []);

  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const value = useMemo(
    () => parseStored(raw, initial, validate),
    [raw, initial, validate],
  );

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = parseStored(readStoredRaw(key), initial, validate);
      const resolved =
        typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      const serialized = JSON.stringify(resolved);
      try {
        window.localStorage.setItem(key, serialized);
      } catch {
        // Quota or blocked storage — nothing persisted, so nothing to announce.
        return;
      }
      // `storage` only fires in other tabs; dispatch so this one re-reads too.
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: serialized }),
      );
    },
    [key, initial, validate],
  );

  return [value, set];
}
