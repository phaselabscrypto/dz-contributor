"use client";

import { Suspense } from "react";
import { useQueryState, parseAsString, parseAsInteger } from "nuqs";
import { PageHeader } from "@/components/ui/page-header";
import { SimulateTab } from "@/components/simulator/simulate-tab";
import { useEpochs } from "@/lib/hooks/use-epochs";
import { useSnapshot } from "@/lib/hooks/use-snapshot";
import { useFees } from "@/lib/hooks/use-fees";
import { LoadingState, ErrorState } from "@/components/ui/states";

function SimulateInner() {
  const { data: epochs, isLoading: epochsLoading, error: epochsError } = useEpochs();

  // Read-only here: the epoch is pinned into the URL by the Share button
  // (see ShareButton in simulate-tab.tsx), not by any picker on this page.
  const [urlEpoch] = useQueryState("epoch", parseAsInteger);
  const [urlContributor, setUrlContributor] = useQueryState(
    "contributor",
    parseAsString.withDefault(""),
  );

  // Derived: URL param wins if present, otherwise fall back to the
  // latest epoch we know about. No state mirror needed.
  const resolvedEpoch: number | null =
    urlEpoch != null ? urlEpoch : epochs?.latest ?? null;

  const { data: snapshot, isLoading: snapshotLoading, error: snapshotError } =
    useSnapshot(resolvedEpoch);
  const {
    data: feeHistory,
    isLoading: feesLoading,
    error: feesError,
  } = useFees();

  const isLoading = epochsLoading || snapshotLoading || feesLoading;
  // Snapshot or epochs failing means we literally can't simulate, so we
  // hard-stop. Fee history failing is degraded — the Shapley delta is
  // still computable, only the projected-revenue figures lose context.
  // Pass the error through so the child can render a visible banner
  // instead of silently displaying "$0 / epoch" everywhere.
  const apiError = epochsError || snapshotError;

  if (apiError) {
    return (
      <ErrorState
        title="Failed to load simulation data"
        message={apiError.message}
      />
    );
  }

  if (isLoading || !snapshot) {
    return <LoadingState label="Loading snapshot" />;
  }

  return (
    <SimulateTab
      snapshot={snapshot}
      feeHistory={feeHistory}
      feeHistoryError={feesError instanceof Error ? feesError : null}
      selectedEpoch={resolvedEpoch}
      initialContributorCode={urlContributor}
      onContributorChange={(code) =>
        setUrlContributor(code === "" ? null : code)
      }
    />
  );
}

export default function SimulatePage() {
  return (
    <>
      <PageHeader
        title="Forecast"
        description="Model contributor and link changes against the Shapley reward solver. Compare before/after share and projected 2Z rewards."
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
        <Suspense fallback={<LoadingState label="Loading" />}>
          <SimulateInner />
        </Suspense>
      </div>
    </>
  );
}
