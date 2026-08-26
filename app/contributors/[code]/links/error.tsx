"use client";

import { RouteErrorPanel } from "@/components/ui/route-error-panel";

export default function ContributorLinksError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorPanel
      title="Contributor links"
      error={error}
      reset={reset}
      source="app/contributors/[code]/links/error.tsx"
    />
  );
}
