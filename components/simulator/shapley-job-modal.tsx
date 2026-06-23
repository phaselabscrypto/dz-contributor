"use client";

import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Clock,
} from "lucide-react";
import type { SimulateResponse } from "@/lib/types/shapley";
import type { FeeHistory } from "@/lib/types/fees";
import { formatSolFromSol, formatUsd } from "@/lib/utils/format";
import {
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";

/* ─── Types ─────────────────────────────────────────────────────── */

export type JobState = "confirming" | "running" | "done" | "error";

interface ChangeSummary {
  removed: number;
  added: number;
  demandOverrides: number;
}

export interface ResultsData {
  beforePct: number;
  afterPct: number;
  deltaPct: number;
  beforeSolEpoch: number;
  afterSolEpoch: number;
  deltaSolEpoch: number;
  beforeSolMonth: number;
  afterSolMonth: number;
  beforeSolYear: number;
  afterSolYear: number;
  afterSolEpochUsd: number | null;
  deltaSolEpochUsd: number | null;
  afterSolYearUsd: number | null;
}

export interface ShapleyJobModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  state: JobState;
  phase: string | null;
  percent: number;
  /** True when polls are transiently failing but the job is still being retried. */
  reconnecting?: boolean;
  error: string | null;
  changeSummary: ChangeSummary;
  /** Computed results (available when state === "done"). */
  results: ResultsData | null;
  simResult: SimulateResponse | null;
  isNewContributor: boolean;
  contributorCode: string;
  avgFeeSol: number;
  feeHistory?: FeeHistory | null;
}

/* ─── Helpers ───────────────────────────────────────────────────── */

function fmtPct(pct: number, decimals = 2): string {
  return pct.toFixed(decimals) + "%";
}

function roundPct(ratio: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(ratio * 100 * factor) / factor;
}

/* ─── Component ─────────────────────────────────────────────────── */

export function ShapleyJobModal({
  open,
  onOpenChange,
  onConfirm,
  onCancel,
  state,
  phase,
  percent,
  reconnecting = false,
  error,
  changeSummary,
  results,
  simResult,
  isNewContributor,
  contributorCode,
  avgFeeSol,
  feeHistory,
}: ShapleyJobModalProps) {
  const isRunning = state === "running";

  // Unified progress: baseline = 0-50%, modified = 50-100%
  const unifiedPercent = useMemo(() => {
    if (state === "done") return 100;
    if (state !== "running") return 0;
    if (phase === "modified") return 50 + percent / 2;
    return percent / 2; // baseline or unknown phase
  }, [state, phase, percent]);

  const handleOpenChange = (nextOpen: boolean) => {
    // Block close during computation — only the Cancel button exits
    if (!nextOpen && isRunning) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        hideClose={isRunning}
        className="sm:max-w-3xl"
        onEscapeKeyDown={(e) => {
          if (isRunning) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (isRunning) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (isRunning) e.preventDefault();
        }}
      >
        {/* ── Confirmation State ───────────────────────────────── */}
        {state === "confirming" && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-4">
                <div className="flex size-11 items-center justify-center rounded-lg bg-amber/10 border border-amber/20">
                  <AlertTriangle className="size-5 text-amber" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>Confirm Calculation</DialogTitle>
                  <DialogDescription>
                    Review your scenario before computing
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <DialogBody>
              <div className="space-y-5">
                <div className="rounded-lg bg-cream-3 border border-cream-8 p-5 space-y-3">
                  <p className="text-sm text-cream-60 leading-relaxed">
                    Please verify your scenario variables are correct before
                    proceeding. Once started, the Shapley value computation runs
                    as a single blocking operation.
                  </p>
                  <div className="flex items-center gap-2 text-xs text-cream-40">
                    <Clock className="size-3.5 shrink-0" />
                    <span>This can take up to 15 minutes to compute</span>
                  </div>
                </div>

                {/* Change summary */}
                <div>
                  <p className="text-xs text-cream-40 mb-2.5">Pending changes</p>
                  <div className="flex flex-wrap gap-2">
                    {changeSummary.removed > 0 && (
                      <Badge
                        variant="secondary"
                        className="text-xs bg-red/10 text-red border-red/20"
                      >
                        −{changeSummary.removed} removed
                      </Badge>
                    )}
                    {changeSummary.added > 0 && (
                      <Badge
                        variant="secondary"
                        className="text-xs bg-green/10 text-green border-green/20"
                      >
                        +{changeSummary.added} added
                      </Badge>
                    )}
                    {changeSummary.demandOverrides > 0 && (
                      <Badge
                        variant="secondary"
                        className="text-xs bg-blue/10 text-blue border-blue/20"
                      >
                        Δ{changeSummary.demandOverrides} demand override
                        {changeSummary.demandOverrides !== 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            </DialogBody>

            <DialogFooter>
              <button
                onClick={onCancel}
                className="rounded-lg border border-cream-15 px-5 py-2.5 text-sm text-cream-60 hover:text-cream hover:border-cream-30 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="rounded-lg bg-cream text-dark font-display text-sm tracking-wide px-6 py-2.5 shadow-lg transition-all hover:bg-cream-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Confirm &amp; Calculate
              </button>
            </DialogFooter>
          </>
        )}

        {/* ── Running State ────────────────────────────────────── */}
        {state === "running" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5">
                <Loader2 className="size-5 animate-spin text-cream-60" />
                Computing Shapley Values
              </DialogTitle>
              <DialogDescription>
                Analysing coalition contributions across the network
              </DialogDescription>
            </DialogHeader>

            <DialogBody>
              <div className="space-y-6">
                {/* Step indicators */}
                <div className="space-y-4">
                  {/* Step 1: Baseline */}
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex size-7 items-center justify-center rounded-full border transition-colors ${
                        phase === "modified"
                          ? "border-green/40 bg-green/20"
                          : "border-cream/40 bg-cream/20 animate-pulse"
                      }`}
                    >
                      {phase === "modified" ? (
                        <CheckCircle2 className="size-4 text-green" />
                      ) : (
                        <span className="text-xs font-mono text-cream">
                          1
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-sm ${
                        phase === "baseline"
                          ? "text-cream"
                          : phase === "modified"
                            ? "text-cream-40"
                            : "text-cream-40"
                      }`}
                    >
                      Computing baseline values
                    </span>
                    {phase === "baseline" && (
                      <span className="text-xs font-mono text-cream-40 ml-auto tabular-nums">
                        {Math.round(percent)}%
                      </span>
                    )}
                    {phase === "modified" && (
                      <span className="text-xs font-mono text-green ml-auto">
                        done
                      </span>
                    )}
                  </div>

                  {/* Step 2: Modified */}
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex size-7 items-center justify-center rounded-full border transition-colors ${
                        phase === "modified"
                          ? "border-cream/40 bg-cream/20 animate-pulse"
                          : "border-cream-15 bg-cream-5"
                      }`}
                    >
                      <span
                        className={`text-xs font-mono ${
                          phase === "modified" ? "text-cream" : "text-cream-30"
                        }`}
                      >
                        2
                      </span>
                    </div>
                    <span
                      className={`text-sm ${
                        phase === "modified" ? "text-cream" : "text-cream-30"
                      }`}
                    >
                      Running what-if scenario
                    </span>
                    {phase === "modified" && (
                      <span className="text-xs font-mono text-cream-40 ml-auto tabular-nums">
                        {Math.round(percent)}%
                      </span>
                    )}
                  </div>
                </div>

                {/* Unified progress bar */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-cream-40 font-mono uppercase tracking-[0.14em]">
                      Overall progress
                    </span>
                    <span className="text-cream font-mono tabular-nums">
                      {Math.round(unifiedPercent)}%
                    </span>
                  </div>
                  <div
                    className="h-2.5 w-full overflow-hidden rounded-full bg-cream/10"
                    role="progressbar"
                    aria-valuenow={Math.round(unifiedPercent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-cream transition-[width] duration-500 ease-out relative overflow-hidden"
                      style={{
                        width: `${Math.max(2, Math.min(100, unifiedPercent))}%`,
                      }}
                    >
                      {/* Shimmer overlay */}
                      <div
                        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"
                        style={{ animation: "shimmer 2s ease-in-out infinite" }}
                      />
                    </div>
                  </div>
                </div>

                {/* Transient connection-loss hint — the job keeps running in
                    the worker; we're only retrying the status poll. */}
                {reconnecting && (
                  <div className="flex items-center gap-2 rounded-lg bg-amber/10 border border-amber/20 px-3 py-2 text-xs text-amber">
                    <Loader2 className="size-3.5 animate-spin shrink-0" />
                    <span>
                      Connection interrupted — reconnecting&hellip; your
                      calculation is still running.
                    </span>
                  </div>
                )}
              </div>
            </DialogBody>

            <DialogFooter>
              <button
                onClick={onCancel}
                className="rounded-lg border border-cream-15 px-5 py-2.5 text-sm text-cream-60 hover:text-cream hover:border-cream-30 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Cancel
              </button>
            </DialogFooter>
          </>
        )}

        {/* ── Done State — Results ─────────────────────────────── */}
        {state === "done" && results && simResult && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-4">
                <div className="flex size-11 items-center justify-center rounded-lg bg-green/10 border border-green/20">
                  <CheckCircle2 className="size-5 text-green" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>Calculation Complete</DialogTitle>
                  <DialogDescription>
                    Shapley value analysis results
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <DialogBody className="max-h-[60vh] overflow-y-auto space-y-5">
              {/* Before / Delta / After comparison */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Before */}
                <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center">
                  <p className="text-xs text-cream-40 mb-1.5">
                    {isNewContributor ? "Before you join" : "Current share"}
                  </p>
                  <p className="text-xl font-display text-cream">
                    {fmtPct(results.beforePct)}
                  </p>
                  {avgFeeSol > 0 && (
                    <p className="text-xs text-cream-30 mt-1.5 font-mono">
                      ~{formatSolFromSol(results.beforeSolEpoch, 4)} SOL /
                      epoch
                    </p>
                  )}
                </div>

                {/* Delta */}
                <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center flex flex-col items-center justify-center">
                  <p className="text-xs text-cream-40 mb-1.5">Change</p>
                  <div className="flex items-center gap-1">
                    {results.deltaPct > 0.001 ? (
                      <ArrowUpRight className="size-4 text-green" />
                    ) : results.deltaPct < -0.001 ? (
                      <ArrowDownRight className="size-4 text-red" />
                    ) : (
                      <Minus className="size-4 text-cream-30" />
                    )}
                    <span
                      className={`text-xl font-display ${
                        results.deltaPct > 0.001
                          ? "text-green"
                          : results.deltaPct < -0.001
                            ? "text-red"
                            : "text-cream-30"
                      }`}
                    >
                      {results.deltaPct > 0 ? "+" : ""}
                      {fmtPct(results.deltaPct)}
                    </span>
                  </div>
                  {avgFeeSol > 0 && (
                    <p className="text-xs text-cream-30 mt-1.5 font-mono">
                      {results.deltaSolEpoch >= 0 ? "+" : ""}
                      {formatSolFromSol(results.deltaSolEpoch, 4)} SOL / epoch
                    </p>
                  )}
                </div>

                {/* After */}
                <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center">
                  <p className="text-xs text-cream-40 mb-1.5">Projected share</p>
                  <p className="text-xl font-display text-cream">
                    {fmtPct(results.afterPct)}
                  </p>
                  {avgFeeSol > 0 && (
                    <>
                      <p className="text-xs text-cream-30 mt-1.5 font-mono">
                        ~{formatSolFromSol(results.afterSolEpoch, 4)} SOL /
                        epoch
                      </p>
                      {results.afterSolEpochUsd != null && (
                        <p className="text-xs text-cream-20 mt-0.5 font-mono">
                          ≈ {formatUsd(results.afterSolEpochUsd, 2)}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Monthly / Yearly projections */}
              {avgFeeSol > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center">
                    <p className="text-xs text-cream-40 mb-1.5">
                      Projected monthly
                    </p>
                    <p className="text-base font-mono tabular-nums text-cream">
                      {formatSolFromSol(results.afterSolMonth, 2)} SOL
                    </p>
                    {!isNewContributor && (
                      <p className="text-xs text-cream-20 mt-1 font-mono">
                        was {formatSolFromSol(results.beforeSolMonth, 2)} SOL
                      </p>
                    )}
                  </div>
                  <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center">
                    <p className="text-xs text-cream-40 mb-1.5">
                      Projected yearly
                    </p>
                    <p className="text-base font-mono tabular-nums text-cream">
                      {formatSolFromSol(results.afterSolYear, 2)} SOL
                    </p>
                    {results.afterSolYearUsd != null && (
                      <p className="text-xs text-cream-20 mt-0.5 font-mono">
                        ≈ {formatUsd(results.afterSolYearUsd, 0)}
                      </p>
                    )}
                    {!isNewContributor && (
                      <p className="text-xs text-cream-20 mt-1 font-mono">
                        was {formatSolFromSol(results.beforeSolYear, 2)} SOL
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Impact on all contributors */}
              <div>
                <p className="text-xs text-cream-40 mb-2.5">
                  Impact on all contributors
                </p>
                <div className="space-y-1 max-h-[200px] overflow-y-auto">
                  {simResult.allContributors
                    .filter((c) => c.beforeShare > 0 || c.afterShare > 0)
                    .sort((a, b) => b.afterShare - a.afterShare)
                    .map((c) => {
                      const bPct = roundPct(c.beforeShare);
                      const aPct = roundPct(c.afterShare);
                      const dPct = Math.round((aPct - bPct) * 100) / 100;
                      const apiCode = isNewContributor
                        ? "new_contributor_sim"
                        : contributorCode;
                      const isTarget = c.code === apiCode;
                      return (
                        <div
                          key={c.code}
                          className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs ${
                            isTarget ? "bg-cream-8" : ""
                          }`}
                        >
                          <span
                            className="size-2 rounded-full shrink-0"
                            style={{
                              backgroundColor: getContributorColor(c.code),
                            }}
                          />
                          <span
                            className={`flex-1 ${isTarget ? "text-cream font-medium" : "text-cream-60"}`}
                          >
                            {c.code === "new_contributor_sim"
                              ? "You (new)"
                              : getContributorDisplayName(c.code)}
                          </span>
                          <span className="text-cream-40 tabular-nums">
                            {fmtPct(bPct)}
                          </span>
                          <ArrowRight className="size-2.5 text-cream-20" />
                          <span className="text-cream-60 tabular-nums">
                            {fmtPct(aPct)}
                          </span>
                          <span
                            className={`tabular-nums w-16 text-right ${
                              dPct > 0.001
                                ? "text-green"
                                : dPct < -0.001
                                  ? "text-red"
                                  : "text-cream-20"
                            }`}
                          >
                            {dPct > 0 ? "+" : ""}
                            {fmtPct(dPct)}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>

              <p className="text-xs text-cream-20 text-center pt-1">
                Based on Shapley value analysis with historical fee averages
                {feeHistory && feeHistory.epochs.length > 0
                  ? ` (epochs ${feeHistory.earliestEpoch}–${feeHistory.latestEpoch})`
                  : ""}
                .
              </p>
            </DialogBody>

            <DialogFooter>
              <button
                onClick={() => onOpenChange(false)}
                className="rounded-lg bg-cream text-dark font-display text-sm tracking-wide px-6 py-2.5 shadow-lg transition-all hover:bg-cream-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Close
              </button>
            </DialogFooter>
          </>
        )}

        {/* ── Error State ──────────────────────────────────────── */}
        {state === "error" && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-4">
                <div className="flex size-11 items-center justify-center rounded-lg bg-red/10 border border-red/20">
                  <XCircle className="size-5 text-red" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>Calculation Failed</DialogTitle>
                  <DialogDescription>
                    An error occurred during computation
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <DialogBody>
              <div className="rounded-lg bg-red/5 border border-red/20 px-4 py-3.5 text-sm text-red leading-relaxed">
                {error || "An unknown error occurred"}
              </div>
            </DialogBody>

            <DialogFooter>
              <button
                onClick={onCancel}
                className="rounded-lg bg-cream text-dark font-display text-sm tracking-wide px-6 py-2.5 shadow-lg transition-all hover:bg-cream-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Dismiss
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
