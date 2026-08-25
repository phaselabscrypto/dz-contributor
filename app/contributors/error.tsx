"use client";

import { RouteErrorPanel } from "@/components/ui/route-error-panel";

export default function ContributorsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorPanel
      title="Contributors"
      error={error}
      reset={reset}
      source="app/contributors/error.tsx"
    />
  );
}
