"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * useState that mirrors itself to localStorage. SSR-safe — uses
 * useSyncExternalStore so hydration reads the initial value on the
 * server, then picks up the stored value on the client without
 * cascading renders. Falls back to in-memory if storage is
 * unavailable (private mode, quota, etc.).
 */
export function useLocalStorageState<T>(
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const handler = (e: StorageEvent) => {
        if (e.key === key) onStoreChange();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
    [key],
  );

  const getSnapshot = useCallback((): T => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      // bad JSON or storage error — fall through
    }
    return initial;
  }, [key, initial]);

  const getServerSnapshot = useCallback((): T => initial, [initial]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = getSnapshot();
      const v =
        typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // ignore — quota / private mode
      }
      // Trigger re-render by dispatching a storage event on this window.
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: JSON.stringify(v) }),
      );
    },
    [key, getSnapshot],
  );

  return [value, set];
}
