"use client";

import { Loader2, AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Animated skeleton block. Matches surface tone so it doesn't pop on
 * dark backgrounds.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse bg-surface-2/60 rounded-sm ${className}`}
    />
  );
}

/**
 * 4-up stat row skeleton (matches the standard Stat grid).
 */
export function StatRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-px border border-border bg-border">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-surface px-4 py-3 space-y-2">
          <Skeleton className="h-2 w-16" />
          <Skeleton className="h-6 w-24" />
        </div>
      ))}
    </div>
  );
}

/**
 * Generic table skeleton — header band + N data rows.
 */
export function TableSkeleton({
  rows = 8,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border bg-surface-2/40 px-3 py-2.5 grid gap-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-2.5 w-16" />
        ))}
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="px-3 py-3 grid gap-3 items-center"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }).map((_, j) => (
              <Skeleton
                key={j}
                className={`h-3 ${j === 0 ? "w-32" : "w-16"}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Stacked section skeleton — heading + 2 rows of content. Use as a
 * lightweight stand-in for any card-shaped page section.
 */
export function SectionSkeleton({ title }: { title?: string }) {
  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5">
        {title ? (
          <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
            {title}
          </span>
        ) : (
          <Skeleton className="h-2.5 w-32" />
        )}
      </div>
      <div className="p-4 space-y-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}

/**
 * Centred page-level loading state. Use inside <main> for any route that
 * waits on a network fetch before rendering.
 */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      <span className="text-xs font-mono uppercase tracking-[0.14em]">
        {label}
      </span>
    </div>
  );
}

/**
 * Page-level error state. Surfaces a short message + optional retry.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border border-red-500/30 bg-red-500/5 px-4 py-4 sm:px-5 sm:py-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-4 text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-red-300">{title}</div>
          {message && (
            <div className="mt-1 text-xs text-red-300/70 break-words">
              {message}
            </div>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex items-center gap-1.5 border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 px-2.5 py-1 text-xs uppercase tracking-[0.14em] font-mono text-red-300 transition-colors"
            >
              <RefreshCw className="size-3" />
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Generic empty-state surface. Use where a list/table renders zero rows
 * after a successful fetch.
 */
export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border border-border bg-surface px-4 py-12 sm:py-16 text-center">
      <Inbox className="size-5 text-muted-foreground mx-auto mb-3" />
      <div className="text-sm text-foreground">{title}</div>
      {message && (
        <div className="mt-1 text-xs text-muted-foreground">{message}</div>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
