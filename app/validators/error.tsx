"use client";

import { RouteErrorPanel } from "@/components/ui/route-error-panel";

export default function ValidatorsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorPanel
      title="Validators"
      error={error}
      reset={reset}
      source="app/validators/error.tsx"
    />
  );
}
