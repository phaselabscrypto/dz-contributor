"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/states";
import { reportError } from "@/lib/observability";

type RouteErrorPanelProps = {
  title: string;
  error: Error & { digest?: string };
  reset: () => void;
  source: string;
};

/**
 * Shared body for a route's `error.tsx`. Keeps the page header, so a failed
 * table is scoped to the table area. `reset` re-renders the segment, which
 * only helps if the cause was transient.
 */
export function RouteErrorPanel({
  title,
  error,
  reset,
  source,
}: RouteErrorPanelProps) {
  useEffect(() => {
    reportError(error, { source, extras: { digest: error.digest } });
  }, [error, source]);

  return (
    <>
      <PageHeader title={title} description="This page failed to render." />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
        <ErrorState
          title="Couldn't load this page"
          message={error.message}
          onRetry={reset}
        />
      </div>
    </>
  );
}
