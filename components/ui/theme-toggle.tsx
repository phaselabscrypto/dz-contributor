"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";

const STORAGE_KEY = "dz:theme";

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

// Stable snapshot for useSyncExternalStore. Cache the last-seen raw
// value so repeated reads return the same string reference (avoiding
// the "snapshot changes every call" infinite-render trap).
let cachedRaw: string | null = null;
let cachedTheme: Theme | null = null;
function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === cachedRaw) return cachedTheme;
  cachedRaw = raw;
  cachedTheme = raw === "light" || raw === "dark" ? raw : null;
  return cachedTheme;
}

function subscribeToTheme(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/**
 * Theme toggle backed by localStorage. SSR-safe via useSyncExternalStore
 * (server snapshot returns null → default to "dark", matching the SSR'd
 * `data-theme="dark"` on <html>).
 */
export function ThemeToggle() {
  const stored = useSyncExternalStore(
    subscribeToTheme,
    getStoredTheme,
    () => null,
  );
  const theme: Theme = stored ?? "dark";

  // Keep <html data-theme> in sync with the resolved theme. This is a
  // genuine "sync React state to an external system" effect — no state
  // mutation, so the lint rule is satisfied.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
      // Synthetic storage event so our own tab re-reads the snapshot.
      // (Native `storage` event only fires for OTHER tabs.)
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    } catch {
      // ignore quota / blocked storage
    }
  };

  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="size-7 border border-border flex items-center justify-center hover:bg-surface-2/60 transition-colors text-muted-foreground hover:text-foreground"
    >
      {isDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </button>
  );
}
