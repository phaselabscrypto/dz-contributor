"use client";

import { RouteErrorPanel } from "@/components/ui/route-error-panel";

export default function LinksError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorPanel
      title="Links"
      error={error}
      reset={reset}
      source="app/links/error.tsx"
    />
  );
}
