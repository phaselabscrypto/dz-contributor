"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

const NAV: Record<string, { href: string; label: string }> = {
  n: { href: "/network", label: "Network" },
  c: { href: "/contributors", label: "Contributors" },
  v: { href: "/validators", label: "Validators" },
  l: { href: "/links", label: "Links" },
  f: { href: "/simulate", label: "Forecast" },
  e: { href: "/economics", label: "Economics" },
  r: { href: "/rewards", label: "Rewards" },
  d: { href: "/changelog", label: "Changelog" },
  s: { href: "/status", label: "Status" },
  m: { href: "/methodology", label: "Methodology" },
  h: { href: "/", label: "Home" },
};

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * Global keyboard shortcuts:
 *  - `g <key>`: nav to a top-level page (vim-style chord, 1.5s expiry)
 *  - `/`: focus the first input on the page
 *  - `?`: open the shortcut help overlay
 *  - `Esc`: close the help overlay
 */
export function KeyboardShortcuts() {
  const router = useRouter();
  const [showHelp, setShowHelp] = useState(false);
  const [chordPending, setChordPending] = useState(false);

  // Reset chord after 1.5s if no follow-up
  useEffect(() => {
    if (!chordPending) return;
    const t = setTimeout(() => setChordPending(false), 1500);
    return () => clearTimeout(t);
  }, [chordPending]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Escape closes help even from inside inputs
      if (e.key === "Escape" && showHelp) {
        setShowHelp(false);
        return;
      }

      if (isEditable(e.target)) return;

      if (chordPending) {
        const key = e.key.toLowerCase();
        const target = NAV[key];
        if (target) {
          e.preventDefault();
          router.push(target.href);
        }
        setChordPending(false);
        return;
      }

      if (e.key === "g") {
        setChordPending(true);
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(
          'input[type="text"], input[type="search"]',
        );
        input?.focus();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
    },
    [router, chordPending, showHelp],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  return (
    <>
      {chordPending && (
        <div className="fixed bottom-4 left-4 z-50 rounded border border-border bg-surface-2 px-3 py-1.5 text-xs font-mono uppercase tracking-[0.14em] text-cream-60 shadow-lg">
          g … press a key
        </div>
      )}
      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
          onClick={() => setShowHelp(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-md mx-4 border border-border bg-surface p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-base tracking-wide text-foreground">
                Keyboard shortcuts
              </h2>
              <button
                onClick={() => setShowHelp(false)}
                aria-label="Close"
                className="text-cream-30 hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs">
              <div>
                <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono mb-1.5">
                  Navigation (g + key)
                </div>
                <div className="grid grid-cols-2 gap-y-1 font-mono">
                  {Object.entries(NAV).map(([k, v]) => (
                    <div
                      key={k}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="text-cream-60">{v.label}</span>
                      <span className="text-cream-30">g {k}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="border-t border-border pt-3">
                <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono mb-1.5">
                  Other
                </div>
                <div className="grid grid-cols-2 gap-y-1 font-mono">
                  <span className="text-cream-60">Focus search</span>
                  <span className="text-cream-30">/</span>
                  <span className="text-cream-60">Show this help</span>
                  <span className="text-cream-30">?</span>
                  <span className="text-cream-60">Close</span>
                  <span className="text-cream-30">Esc</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
