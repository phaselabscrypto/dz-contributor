"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/observability";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, {
      source: "app/error.tsx (root error boundary)",
      extras: { digest: error.digest },
    });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark p-6">
      <div className="max-w-md text-center space-y-4">
        <h2 className="font-display text-xl text-cream">Something went wrong</h2>
        <p className="text-sm text-cream-40">
          {error.message || "An unexpected error occurred."}
        </p>
        <button
          onClick={reset}
          className="rounded-lg bg-cream text-dark font-display text-sm tracking-wide px-6 py-2.5 transition-all hover:bg-cream-80"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
