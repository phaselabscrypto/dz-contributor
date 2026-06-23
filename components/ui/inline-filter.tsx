"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type InlineFilterOption<T extends string = string> = {
  value: T;
  label: ReactNode;
};

type InlineFilterProps<T extends string> = {
  label?: string;
  value: T;
  options: ReadonlyArray<InlineFilterOption<T>>;
  onChange: (next: T) => void;
  className?: string;
};

export function InlineFilter<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: InlineFilterProps<T>) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {label && (
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          {label}
        </span>
      )}
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex border border-border bg-surface"
      >
        {options.map((opt, i) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt.value)}
              className={cn(
                "px-2.5 py-1 text-xs transition-colors tabular-nums",
                i > 0 && "border-l border-border",
                active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground hover:bg-surface-3",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
