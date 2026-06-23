"use client";

/**
 * "Powered by Phase" lockup. Used in sidebar footer (prominent) and
 * page-level footer (compact).
 */
export function PhaseLockup() {
  return (
    <div className="px-5 py-3 flex flex-col gap-1.5">
      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-mono">
        Powered by
      </div>
      <a
        href="https://phase.cc"
        target="_blank"
        rel="noreferrer"
        className="group inline-flex items-center gap-2 self-start"
      >
        <span
          aria-hidden
          className="size-3 border border-primary/60 bg-primary/30 group-hover:bg-primary group-hover:border-primary transition-colors"
        />
        <span className="font-display text-base tracking-[0.18em] text-foreground group-hover:text-primary transition-colors">
          PHASE
        </span>
      </a>
    </div>
  );
}

export function PhaseFooter() {
  return (
    <footer className="border-t border-border px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs uppercase tracking-[0.16em] text-muted-foreground font-mono">
      <a
        href="https://phase.cc"
        target="_blank"
        rel="noreferrer"
        className="group inline-flex items-center gap-2 hover:text-foreground transition-colors"
      >
        <span
          aria-hidden
          className="size-2.5 border border-primary/60 bg-primary/30 group-hover:bg-primary group-hover:border-primary transition-colors"
        />
        <span>Powered by Phase</span>
      </a>
      <div className="flex items-center gap-3">
        <a
          href="https://data.malbeclabs.com"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground transition-colors"
        >
          malbeclabs
        </a>
        <span aria-hidden>·</span>
        <a
          href="https://doublezero.xyz"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground transition-colors"
        >
          doublezero.xyz
        </a>
        <span aria-hidden>·</span>
        <a
          href="https://github.com/doublezerofoundation/network-shapley-rs"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground transition-colors"
        >
          shapley-rs
        </a>
      </div>
    </footer>
  );
}
