"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useQueryState, createParser } from "nuqs";
import {
  parseAsRemovedLinks,
  parseAsAddedLinks,
  parseAsDemandOverrides,
} from "@/lib/utils/scenario-url";
import type { ParsedSnapshot } from "@/lib/types/contributor";
import type { FeeHistory } from "@/lib/types/fees";
import type { SimulateResponse } from "@/lib/types/shapley";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  getContributorDisplayName,
  getContributorColor,
  CONTRIBUTOR_SHARE,
  EPOCHS_PER_MONTH,
  EPOCHS_PER_YEAR,
  NEW_CONTRIBUTOR_SIM_CODE,
} from "@/lib/constants/config";
import dynamic from "next/dynamic";
import { findCoverageGaps } from "@/lib/utils/demand";
import { ShapleyJobModal, type JobState } from "./shapley-job-modal";

// Defer the map's d3-projection chain to first paint. The simulator
// is a deep funnel; users land on the contributor picker first and
// don't need the map's ~150KB until they're choosing cities.
const SimulatorMap = dynamic(
  () => import("./simulator-map").then((m) => m.SimulatorMap),
  {
    ssr: false,
    loading: () => (
      <div className="border border-cream-8 bg-cream-3 aspect-[16/7] flex items-center justify-center text-xs font-mono uppercase tracking-[0.14em] text-cream-40">
        Loading map…
      </div>
    ),
  },
);
import {
  formatSolFromSol,
  formatUsd,
} from "@/lib/utils/format";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  X,
  Plus,
  Share2,
  Check,
} from "lucide-react";

const NEW_CONTRIBUTOR_VALUE = "__new__";

/**
 * `run=1` marks a shared forecast that should auto-run on open. Only the Share
 * button stamps it (AD5); a plain editor/bookmark URL never carries it, so a
 * work-in-progress reload never fires a solve. Kept as a terse literal `1`
 * rather than nuqs's `parseAsBoolean` ("true"/"false") for a tidy share URL.
 */
const parseAsRunFlag = createParser({
  parse: (v: string) => v === "1",
  serialize: (v: boolean) => (v ? "1" : ""),
}).withDefault(false);

// A completed job whose Redis state hash has aged out surfaces as the service's
// "job not found (expired?)" string (getSimulateJob maps the 404 → failed). We
// turn that dead-end into an actionable hint — re-running recomputes, and a
// recently-solved scenario returns instantly from the durable result store.
const EXPIRED_JOB_MESSAGE =
  "This simulation has expired — Run again to recompute (recent results return instantly).";

/** Map the raw job error to friendlier copy for the expired-job case. */
function displaySimError(error: string | null): string | null {
  if (!error) return error;
  return error.toLowerCase().includes("job not found")
    ? EXPIRED_JOB_MESSAGE
    : error;
}

// ── Async-job polling policy ────────────────────────────────────────────────
// A what-if job runs in the worker independently of this browser tab, so a
// transient poll failure (a network blip, the brief job-not-yet-visible 404
// right after enqueue, a route/API hiccup during a rolling restart) must NOT
// abandon a job that's still computing. We keep polling through failures and
// only surface an error after this many CONSECUTIVE failures (~seconds of lost
// contact at the 1s cadence) — or the instant the job reports a terminal state.
const POLL_INTERVAL_MS = 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 20;

// Cancellation is idempotent end-to-end, so retry the request a few times to be
// sure it reaches the server even through a transient client-side blip — a
// single fire-and-forget cancel can otherwise silently fail and leave the
// worker burning a 16-core slot on a job the user explicitly cancelled.
const CANCEL_MAX_ATTEMPTS = 3;
const CANCEL_RETRY_DELAY_MS = 400;

/** Cancel a background job, retried so a transient blip can't drop it. */
async function requestCancel(jobId: string): Promise<void> {
  for (let attempt = 1; attempt <= CANCEL_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`/api/shapley/jobs/${jobId}`, { method: "DELETE" });
      if (res.ok) return; // 200 = cancel landed; non-ok (502) → retry
    } catch {
      /* network blip — retry */
    }
    if (attempt < CANCEL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, CANCEL_RETRY_DELAY_MS * attempt));
    }
  }
  console.warn(
    `[simulate] cancel for job ${jobId} not confirmed after ${CANCEL_MAX_ATTEMPTS} attempts`
  );
}

interface SimulateTabProps {
  snapshot: ParsedSnapshot;
  feeHistory: FeeHistory | undefined;
  /**
   * Error from the fee-history fetch. When present, the simulator
   * renders an explicit banner instead of silently dropping the
   * projected-revenue figures (no-silent-fallbacks rule, issue #19).
   */
  feeHistoryError?: Error | null;
  selectedEpoch: number | null;
  /** Initial contributor code (e.g., from URL state). */
  initialContributorCode?: string;
  /** Called whenever the user changes the active contributor — wire to URL state for shareable links. */
  onContributorChange?: (code: string) => void;
}

/**
 * Round a 0-1 ratio to a percentage with `decimals` digits, returning the number.
 * e.g. roundPct(0.062149, 2) = 6.21
 */
function roundPct(ratio: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(ratio * 100 * factor) / factor;
}

/**
 * Format a pre-rounded percentage number as a string.
 */
function fmtPct(pct: number, decimals = 2): string {
  return pct.toFixed(decimals) + "%";
}

/**
 * Copy the current scenario URL — with `run=1` stamped so it auto-runs on
 * open, and the resolved `epoch` pinned — to the clipboard, with a transient
 * "Copied" confirmation. The edit params are already live-synced to the URL
 * (nuqs), but `epoch` is not (the page resolves it to `latest` when absent),
 * so pinning it here is what makes a shared forecast reproduce the same
 * baseline — and hit the S3 cache — when reopened after epochs have rolled.
 */
function ShareButton({
  className,
  epoch,
}: {
  className: string;
  epoch: number | null;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const handleShare = async () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("run", "1");
      if (epoch != null) url.searchParams.set("epoch", String(epoch));
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied) — a convenience action,
      // so skip the confirmation rather than surface an error.
    }
  };

  return (
    <button type="button" onClick={handleShare} className={className}>
      {copied ? (
        <>
          <Check className="size-4 shrink-0" />
          Copied
        </>
      ) : (
        <>
          <Share2 className="size-4 shrink-0" />
          Share
        </>
      )}
    </button>
  );
}

export function SimulateTab({
  snapshot,
  feeHistory,
  feeHistoryError,
  selectedEpoch,
  initialContributorCode = "",
  onContributorChange,
}: SimulateTabProps) {
  const [contributorCode, setContributorCode] = useState<string>(initialContributorCode);
  // Scenario edits live in the URL (nuqs) so a forecast is shareable and
  // survives reload — see lib/utils/scenario-url.ts. removedLinks is consumed
  // as a Set, but the URL holds an array; derive the Set and write arrays back.
  const [removeParam, setRemoveParam] = useQueryState("remove", parseAsRemovedLinks);
  const removedLinks = useMemo(() => new Set(removeParam), [removeParam]);
  const [addedLinks, setAddedLinks] = useQueryState("add", parseAsAddedLinks);
  const [newCityA, setNewCityA] = useState("");
  const [newCityZ, setNewCityZ] = useState("");
  const [newBandwidth, setNewBandwidth] = useState<number>(10);
  const [newLatency, setNewLatency] = useState<number>(10);
  // Metro-keyed (uppercased exchange code, e.g. "FRA") validator-count overrides.
  const [demandOverrides, setDemandOverrides] = useQueryState("demand", parseAsDemandOverrides);
  // `run=1` (stamped only by Share) auto-runs the scenario once on open. Epoch
  // and contributor are already resolved when this tab mounts (the page gates
  // on a loaded snapshot), so the run decision is knowable synchronously — we
  // freeze it once so a later contributor/epoch change can't retroactively
  // trigger a run. Also require decodable edits, mirroring the manual button's
  // `hasChanges` gate — a `run=1` URL with none would otherwise fire a
  // baseline-vs-baseline no-op solve.
  const [runFlag] = useQueryState("run", parseAsRunFlag);
  const [autoRunOnMount] = useState(() => {
    const hasEditsAtMount =
      removeParam.length > 0 ||
      addedLinks.length > 0 ||
      Object.keys(demandOverrides).length > 0;
    return (
      runFlag &&
      selectedEpoch != null &&
      contributorCode !== "" &&
      hasEditsAtMount
    );
  });
  const [showDemandEditor, setShowDemandEditor] = useState(false);
  const [simResult, setSimResult] = useState<SimulateResponse | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  // Async-job UI: progress % (0–100) + the current phase ("baseline" |
  // "modified"), since the bar is per-phase 0–100 and resets at the handoff.
  const [simPercent, setSimPercent] = useState(0);
  const [simPhase, setSimPhase] = useState<string | null>(null);
  // True while polls are transiently failing but we're still retrying (the job
  // is presumed alive in the worker) — surfaced as a soft "reconnecting" hint.
  const [simReconnecting, setSimReconnecting] = useState(false);
  const jobIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const autoRunFiredRef = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  // The progress modal starts closed even for an auto-run (shared link): a
  // cached scenario resolves instantly and should skip straight to inline
  // results, so handleSimulate reveals the modal lazily only on a cache miss
  // (see the `deferModal` path).
  const [showJobModal, setShowJobModal] = useState(false);
  const [jobState, setJobState] = useState<JobState>(
    autoRunOnMount ? "running" : "confirming"
  );

  // Scroll to results when they arrive
  useEffect(() => {
    if (simResult && resultsRef.current) {
      resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [simResult]);

  // Clear a displayed result when the scenario changes. The edit handlers below
  // already do this, but the scenario now lives in the URL, so browser history
  // navigation (back/forward to a different remove/add/demand set) mutates it
  // without going through a handler. Reset during render via the previous-value
  // pattern (not an effect — React's idiom for "derived state changed") so a
  // stale result never paints over a different scenario. The key is stable
  // during a run, so this never fires mid-poll or clobbers a just-arrived result.
  const scenarioKey = JSON.stringify([removeParam, addedLinks, demandOverrides]);
  const [prevScenarioKey, setPrevScenarioKey] = useState(scenarioKey);
  if (scenarioKey !== prevScenarioKey) {
    setPrevScenarioKey(scenarioKey);
    setSimResult(null);
    setSimError(null);
  }

  const isNewContributor = contributorCode === NEW_CONTRIBUTOR_VALUE;
  const contributor = isNewContributor
    ? null
    : snapshot.contributors.find((c) => c.code === contributorCode);

  const sortedContributors = useMemo(
    () =>
      [...snapshot.contributors]
        .filter((c) => c.linkCount > 0)
        .sort((a, b) => b.linkCount - a.linkCount),
    [snapshot]
  );

  const activeCities = useMemo(
    () =>
      snapshot.cityDemands
        .filter((d) => d.totalSlots > 0)
        .sort((a, b) => b.demandScore - a.demandScore),
    [snapshot]
  );

  const senderMetros = useMemo(
    () => snapshot.metroDemands.filter((m) => m.validatorCount > 0),
    [snapshot]
  );

  // Endpoint pick for "+100G hot corridor": first two activeCities with
  // distinct, defined metroCodes (same-metro links are dropped server-side).
  const hotCorridorPair = useMemo(() => {
    const a = activeCities.find((c) => c.metroCode);
    const b = a
      ? activeCities.find((c) => c.metroCode && c.metroCode !== a.metroCode)
      : undefined;
    return a && b ? ([a, b] as const) : null;
  }, [activeCities]);

  // Endpoint picks for "+3-city hub triangle": top 3 activeCities with
  // pairwise-distinct defined metroCodes.
  const hubTrianglePicks = useMemo(() => {
    const picks: typeof activeCities = [];
    for (const c of activeCities) {
      if (!c.metroCode) continue;
      if (picks.some((p) => p.metroCode === c.metroCode)) continue;
      picks.push(c);
      if (picks.length === 3) break;
    }
    return picks.length === 3 ? picks : null;
  }, [activeCities]);

  // Location -> metro lookup for flagging intra-metro drafts (Task 5).
  const locationToMetro = useMemo(
    () => new Map(snapshot.cityDemands.map((cd) => [cd.locationCode, cd.metroCode])),
    [snapshot]
  );

  const coverageGaps = useMemo(
    () => findCoverageGaps(snapshot.cityDemands, 5),
    [snapshot]
  );

  const demandThresholds = useMemo(() => {
    const scores = activeCities
      .map((d) => d.demandScore)
      .filter((s) => s < 999 && s > 0)
      .sort((a, b) => a - b);
    if (scores.length === 0) return { high: 0.5, moderate: 0.1 };
    const p75 = scores[Math.floor(scores.length * 0.75)];
    const p25 = scores[Math.floor(scores.length * 0.25)];
    return { high: p75, moderate: p25 };
  }, [activeCities]);

  const demandLabel = (score: number) => {
    if (score >= 999) return { text: "Unserved", cls: "text-green" };
    if (score > demandThresholds.high) return { text: "High demand", cls: "text-green" };
    if (score > demandThresholds.moderate) return { text: "Moderate", cls: "text-amber" };
    if (score === 0) return { text: "No demand", cls: "text-cream-20" };
    return { text: "Well covered", cls: "text-cream-30" };
  };

  const demandOverrideCount = Object.keys(demandOverrides).length;
  const hasChanges = isNewContributor
    ? addedLinks.length > 0 || demandOverrideCount > 0
    : removedLinks.size > 0 ||
      addedLinks.length > 0 ||
      demandOverrideCount > 0;
  // Average per-epoch fee revenue in SOL. The contributor pool is the 45%
  // slice of this (CONTRIBUTOR_SHARE). Fall back to 0 if missing — never to
  // a lamports value, which would inflate by 1e9×.
  const avgFeeSol = feeHistory?.averageFeeSol ?? 0;
  const solUsd = feeHistory?.solUsdPrice ?? 0;

  const handleContributorChange = (code: string) => {
    setContributorCode(code);
    // Clearing to null drops the params from the URL (identical edit-reset
    // semantics to before, now also cleaning the shareable link).
    setRemoveParam(null);
    setAddedLinks(null);
    setSimResult(null);
    setSimError(null);
    setNewCityA("");
    setNewCityZ("");
    setDemandOverrides(null);
    setShowDemandEditor(false);
    onContributorChange?.(code);
  };

  const toggleLink = (pubkey: string) => {
    setRemoveParam((prev) => {
      const next = new Set(prev);
      if (next.has(pubkey)) {
        next.delete(pubkey);
      } else {
        next.add(pubkey);
      }
      return Array.from(next);
    });
    setSimResult(null);
  };

  const addLink = () => {
    if (!newCityA || !newCityZ || newCityA === newCityZ) return;
    // Intra-metro links are a solver no-op (rejected server-side); don't let
    // the user stage a draft the API will 400 on.
    const metroA = locationToMetro.get(newCityA);
    const metroZ = locationToMetro.get(newCityZ);
    if (metroA !== undefined && metroA === metroZ) return;
    setAddedLinks((prev) => [
      ...prev,
      {
        cityA: newCityA,
        cityZ: newCityZ,
        bandwidthGbps: newBandwidth,
        latencyMs: newLatency,
      },
    ]);
    setNewCityA("");
    setNewCityZ("");
    setSimResult(null);
  };

  const removeAddedLink = (index: number) => {
    setAddedLinks((prev) => prev.filter((_, i) => i !== index));
    setSimResult(null);
  };

  const handleSimulate = async (opts: { deferModal?: boolean } = {}) => {
    if (!selectedEpoch || !contributorCode) return;
    setSimLoading(true);
    setSimError(null);
    setSimResult(null);
    setSimPercent(0);
    setSimReconnecting(false);
    cancelledRef.current = false;
    jobIdRef.current = null;
    const apiCode = isNewContributor ? NEW_CONTRIBUTOR_SIM_CODE : contributorCode;
    try {
      // 1) Start the background job (returns immediately with a job id).
      const startRes = await fetch("/api/shapley/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epoch: selectedEpoch,
          contributorCode: apiCode,
          removeLinks: isNewContributor ? [] : Array.from(removedLinks),
          addLinks: addedLinks,
          demandOverrides,
        }),
      });
      if (!startRes.ok) {
        // Surface the API's `{ error }` message cleanly (validation 400s carry
        // a self-explaining string); fall back to raw text if it isn't JSON.
        const bodyText = await startRes.text();
        let message = bodyText;
        try {
          const parsed = JSON.parse(bodyText) as { error?: string };
          if (parsed?.error) message = parsed.error;
        } catch {
          /* not JSON — use the raw text */
        }
        throw new Error(message);
      }
      const { jobId } = (await startRes.json()) as { jobId: string };
      jobIdRef.current = jobId;
      // Cancel clicked while the start POST was in flight (it holds the socket
      // through a multi-second snapshot fetch + input build): the modal is
      // already closed and no poll loop will run, so this is the only place
      // that can release the just-enqueued job — otherwise a worker computes
      // a result nobody is tracking.
      if (cancelledRef.current) {
        void requestCancel(jobId);
        return;
      }

      // 2) Poll for progress until the job reaches a terminal state. A job
      // lives in the worker independently of this tab, so transient poll
      // failures must NOT abandon it: we count CONSECUTIVE failures and only
      // give up after MAX_CONSECUTIVE_POLL_FAILURES, keeping the job reference
      // throughout. A successful poll resets the counter; an explicit terminal
      // state (done/failed/cancelled) ends polling immediately.
      // For a deferred (shared-link auto-run) start the modal is still closed —
      // reveal it only if a poll shows the job actually computing, so a cached
      // shared link lands straight on inline results with no "Computing…" flash.
      // `modalOpened` is already true for the manual path (the button opened it).
      let modalOpened = !opts.deferModal;
      let consecutiveFailures = 0;
      let firstPoll = true;
      for (;;) {
        if (cancelledRef.current) return;
        // First poll fires immediately — a cache hit is already `done` on the
        // first GET; only pace SUBSEQUENT polls at POLL_INTERVAL_MS.
        if (!firstPoll) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        firstPoll = false;
        if (cancelledRef.current) return;

        try {
          const pollRes = await fetch(
            `/api/shapley/jobs/${jobId}?contributorCode=${encodeURIComponent(apiCode)}`
          );
          if (!pollRes.ok) {
            throw new Error(`poll ${pollRes.status}: ${await pollRes.text()}`);
          }
          const data = await pollRes.json();

          // Poll succeeded — clear any transient-failure state.
          consecutiveFailures = 0;
          if (!cancelledRef.current) setSimReconnecting(false);

          if (typeof data?.progress?.percent === "number") {
            setSimPercent(data.progress.percent);
          }
          if (typeof data?.progress?.phase === "string") {
            setSimPhase(data.progress.phase);
          }
          if (data.state === "done") {
            setSimPercent(100);
            setSimPhase(null);
            setSimReconnecting(false);
            setSimResult({
              epoch: selectedEpoch,
              contributorCode: apiCode,
              before: data.before,
              after: data.after,
              delta: data.delta,
              allContributors: data.allContributors,
            } as SimulateResponse);
            setJobState("done");
            return;
          }
          if (data.state === "failed") {
            // Explicit terminal failure from the worker — surface immediately,
            // NOT subject to the transient-retry budget.
            setSimError(data.error || "Simulation failed");
            setJobState("error");
            setSimReconnecting(false);
            return;
          }
          if (data.state === "cancelled") {
            setShowJobModal(false);
            setJobState("confirming");
            setSimReconnecting(false);
            return;
          }
          // Still running (no terminal state matched). Reveal the progress modal
          // for a deferred run now that we know it's a real compute, not an
          // instant cache hit.
          if (!modalOpened) {
            setShowJobModal(true);
            setJobState("running");
            modalOpened = true;
          }
        } catch (pollErr) {
          // Transport-level failure (HTTP non-ok or network reject) — transient.
          // Keep the job reference and keep polling until the budget is spent.
          if (cancelledRef.current) return;
          consecutiveFailures += 1;
          console.warn(
            `[simulate] poll ${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES} ` +
              `failed for job ${jobId}; retrying`,
            pollErr
          );
          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            // We've abandoned this job — request cancellation so we don't leave
            // a scarce 16-core worker computing a result nobody is tracking.
            // Best-effort and idempotent (requestCancel retries): if the same
            // path that broke polling is still down it may not land, in which
            // case the worker finishes and caches the result as usual.
            void requestCancel(jobId);
            setSimError(
              `Lost contact with the simulation after ${consecutiveFailures} ` +
                `attempts; requested cancellation (job ${jobId}).`
            );
            setJobState("error");
            setSimReconnecting(false);
            return;
          }
          setSimReconnecting(true);
        }
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setSimError(err instanceof Error ? err.message : "Simulation failed");
        setJobState("error");
      }
    } finally {
      setSimLoading(false);
    }
  };

  /** Called from the confirmation modal — transitions to running and kicks off the job. */
  const handleConfirm = () => {
    setJobState("running");
    handleSimulate();
  };

  // Auto-run a shared forecast. `deferModal` keeps the progress modal closed
  // until a poll proves the job is actually computing — a cached shared link
  // resolves `done` on the first poll and lands straight on inline results with
  // no "Computing…" flash; only a genuine cache miss reveals the modal. The ref
  // guard keeps it to a single fire per mount even under Strict-Mode's
  // double-invoked effects; a fresh mount (reloading the link) re-runs.
  useEffect(() => {
    if (autoRunFiredRef.current || !autoRunOnMount) return;
    autoRunFiredRef.current = true;
    handleSimulate({ deferModal: true });
    // handleSimulate is intentionally omitted — the ref guard fires this once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunOnMount]);

  /** Cancel handler — called from the modal's Cancel button in any state. */
  const handleModalCancel = () => {
    if (jobState === "confirming" || jobState === "done" || jobState === "error") {
      setShowJobModal(false);
      setJobState("confirming");
      if (jobState === "error") setSimError(null);
      return;
    }
    // Running state — full cancel
    cancelledRef.current = true;
    setSimLoading(false);
    setSimReconnecting(false);
    setShowJobModal(false);
    setJobState("confirming");
    const id = jobIdRef.current;
    if (id) {
      // Retry in the background; the modal closes immediately for responsiveness.
      void requestCancel(id);
    }
  };

  const getCityName = (locationCode: string) => {
    const city = snapshot.cityDemands.find((d) => d.locationCode === locationCode);
    return city ? `${city.locationName}` : locationCode;
  };

  // --- Consistent rounding for results ---
  // Round before & after from full precision, then derive delta from the rounded values.
  // This ensures before + delta = after visually.
  const results = useMemo(() => {
    if (!simResult) return null;
    const beforePct = roundPct(simResult.before.share);
    const afterPct = roundPct(simResult.after.share);
    const deltaPct = Math.round((afterPct - beforePct) * 100) / 100;

    // Pool is the 45% contributor slice of per-epoch fee revenue (SOL).
    // Operator's projected SOL = their Shapley share × pool.
    const beforeSolEpoch =
      simResult.before.share * avgFeeSol * CONTRIBUTOR_SHARE;
    const afterSolEpoch =
      simResult.after.share * avgFeeSol * CONTRIBUTOR_SHARE;
    const deltaSolEpoch = afterSolEpoch - beforeSolEpoch;

    return {
      beforePct,
      afterPct,
      deltaPct,
      beforeSolEpoch,
      afterSolEpoch,
      deltaSolEpoch,
      beforeSolMonth: beforeSolEpoch * EPOCHS_PER_MONTH,
      afterSolMonth: afterSolEpoch * EPOCHS_PER_MONTH,
      beforeSolYear: beforeSolEpoch * EPOCHS_PER_YEAR,
      afterSolYear: afterSolEpoch * EPOCHS_PER_YEAR,
      // Optional USD pegs for context (used only if SOL/USD is loaded)
      afterSolEpochUsd: solUsd > 0 ? afterSolEpoch * solUsd : null,
      deltaSolEpochUsd: solUsd > 0 ? deltaSolEpoch * solUsd : null,
      afterSolYearUsd: solUsd > 0 ? afterSolEpoch * EPOCHS_PER_YEAR * solUsd : null,
    };
  }, [simResult, avgFeeSol, solUsd]);

  const showExistingLinks = contributor && !isNewContributor;
  const showAddLinks = contributorCode !== "";

  // True when the two currently-selected "add link" endpoints resolve to the
  // same metro — intra-metro links don't earn rewards.
  const draftEndpointsSameMetro = useMemo(() => {
    if (!newCityA || !newCityZ) return false;
    const metroA = locationToMetro.get(newCityA);
    const metroZ = locationToMetro.get(newCityZ);
    return metroA !== undefined && metroA === metroZ;
  }, [newCityA, newCityZ, locationToMetro]);

  return (
    <div className="space-y-6">
      {/* Fee-history error banner — visible, never silent (issue #19) */}
      {feeHistoryError && (
        <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
          <span>
            Couldn&apos;t load fee history: {feeHistoryError.message}. Shapley
            share calculations still work, but projected SOL / epoch numbers
            are hidden until the feed recovers — they would otherwise display
            as $0 and silently misrepresent rewards.
          </span>
        </div>
      )}
      {/* Disclaimer */}
      <div className="flex items-start gap-2 rounded-lg bg-amber/5 border border-amber/20 px-3 py-2 text-xs text-amber">
        <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
        <span>
          Shapley projection sitting on top of the historical average epoch revenue
          {feeHistory && feeHistory.epochs.length > 0
            ? ` (Solana epochs ${feeHistory.earliestEpoch}–${feeHistory.latestEpoch})`
            : ""}{". "}
          Fees are denominated in SOL on-chain; we display SOL with a live USD
          conversion from Jupiter. Directional — 2Z payouts are not currently active.
        </span>
      </div>

      {/* Step 1: Audience selector — existing operator vs new contributor */}
      <Card className="bg-cream-5 border-cream-8">
        <CardHeader>
          <CardTitle className="font-display text-sm tracking-wide text-cream">
            Who are you?
          </CardTitle>
          <CardDescription className="text-cream-40">
            Forecast as an existing operator changing your links, or as a new
            contributor seeing the reward share you&apos;d add by joining.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div
            role="radiogroup"
            aria-label="Forecast as"
            className="inline-flex border border-cream-15 bg-surface w-full sm:w-[360px]"
          >
            <button
              type="button"
              role="radio"
              aria-checked={!isNewContributor}
              onClick={() => {
                if (isNewContributor) handleContributorChange("");
              }}
              className={`flex-1 px-3 py-2 text-xs font-mono transition-colors ${
                !isNewContributor
                  ? "bg-cream text-dark"
                  : "text-cream-60 hover:text-cream"
              }`}
            >
              Existing operator
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isNewContributor}
              onClick={() => {
                if (!isNewContributor)
                  handleContributorChange(NEW_CONTRIBUTOR_VALUE);
              }}
              className={`flex-1 px-3 py-2 text-xs font-mono transition-colors border-l border-cream-15 ${
                isNewContributor
                  ? "bg-cream text-dark"
                  : "text-cream-60 hover:text-cream"
              }`}
            >
              New contributor
            </button>
          </div>

          {isNewContributor ? (
            <p className="text-xs text-cream-40 flex items-start gap-2">
              <Plus className="size-3 text-green shrink-0 mt-0.5" />
              <span>
                Starting from 0% share — add the links you&apos;d contribute
                below and run the forecast.
              </span>
            </p>
          ) : (
            <Select
              value={contributorCode}
              onValueChange={handleContributorChange}
            >
              <SelectTrigger className="w-full sm:w-[320px]">
                <SelectValue placeholder="Choose your operator..." />
              </SelectTrigger>
              <SelectContent>
                {sortedContributors.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full inline-block"
                        style={{ backgroundColor: getContributorColor(c.code) }}
                      />
                      {getContributorDisplayName(c.code)}
                      <span className="text-cream-30 ml-1">
                        {c.linkCount} links
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      {/* Interactive map */}
      {contributorCode && (
        <Card className="bg-cream-5 border-cream-8">
          <CardHeader>
            <CardTitle className="font-display text-sm tracking-wide text-cream">
              Network map
            </CardTitle>
            <CardDescription className="text-cream-40">
              Click two cities to draft a new link, or click an existing dashed
              line to flag it for removal. Bandwidth and RTT come from the
              inputs below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SimulatorMap
              snapshot={snapshot}
              contributorCode={
                isNewContributor ? null : contributorCode
              }
              removedLinkPubkeys={removedLinks}
              addedLinks={addedLinks}
              onPairSelect={(a, z) => {
                setAddedLinks((prev) => [
                  ...prev,
                  {
                    cityA: a,
                    cityZ: z,
                    bandwidthGbps: newBandwidth,
                    latencyMs: newLatency,
                  },
                ]);
                setSimResult(null);
              }}
              onLinkClick={(pubkey) => toggleLink(pubkey)}
            />
          </CardContent>
        </Card>
      )}

      {/* Step 2: Current links with remove toggles (only for existing contributors) */}
      {showExistingLinks && (
        <Card className="bg-cream-5 border-cream-8">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="font-display text-sm tracking-wide text-cream">
                Current links
              </CardTitle>
              <Badge variant="secondary" className="text-xs">
                {contributor.linkCount - removedLinks.size} of {contributor.linkCount} active
              </Badge>
            </div>
            <CardDescription className="text-cream-40">
              Toggle off links to simulate removing them
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {contributor.links.map((link) => {
                const isRemoved = removedLinks.has(link.pubkey);
                return (
                  <button
                    key={link.pubkey}
                    onClick={() => toggleLink(link.pubkey)}
                    className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm text-left transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                      isRemoved
                        ? "border-red/20 bg-red/5 opacity-50"
                        : "border-cream-8 bg-cream-3 hover:border-cream-15"
                    }`}
                  >
                    <div
                      className={`size-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                        isRemoved
                          ? "border-red/40 bg-red/20"
                          : "border-cream-15 bg-transparent"
                      }`}
                    >
                      {isRemoved && <X className="size-3 text-red" />}
                    </div>
                    <span className={`flex-1 ${isRemoved ? "line-through text-cream-30" : "text-cream-60"}`}>
                      {link.sideA.city || link.sideA.locationCode}
                    </span>
                    <ArrowRight className="size-3 text-cream-20 shrink-0" />
                    <span className={`flex-1 ${isRemoved ? "line-through text-cream-30" : "text-cream-60"}`}>
                      {link.sideZ.city || link.sideZ.locationCode}
                    </span>
                    <span className="text-xs text-cream-20 shrink-0">
                      {link.bandwidthGbps}G
                    </span>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3a: Quick presets */}
      {showAddLinks && (
        <Card className="bg-cream-5 border-cream-8">
          <CardHeader>
            <CardTitle className="font-display text-sm tracking-wide text-cream">
              Quick presets
            </CardTitle>
            <CardDescription className="text-cream-40">
              One-click scenarios that populate the form below. You can edit
              after applying.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {/* 100G hot corridor — picks the top two activeCities with
                   distinct, defined metroCodes so the server doesn't silently
                   drop a same-metro link. */}
              <button
                type="button"
                onClick={() => {
                  if (!hotCorridorPair) return;
                  const [a, b] = hotCorridorPair;
                  setAddedLinks((prev) => [
                    ...prev,
                    {
                      cityA: a.locationCode,
                      cityZ: b.locationCode,
                      bandwidthGbps: 100,
                      latencyMs: 10,
                    },
                  ]);
                  setSimResult(null);
                }}
                disabled={!hotCorridorPair}
                className="text-xs font-mono px-3 py-1.5 border border-cream-15 hover:border-cream-30 hover:bg-cream-8 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                + 100G hot corridor
              </button>

              {/* Strip <1G existing links */}
              {!isNewContributor && contributor && (
                <button
                  type="button"
                  onClick={() => {
                    const subGigs = contributor.links
                      .filter((l) => l.bandwidthGbps < 1)
                      .map((l) => l.pubkey);
                    if (subGigs.length === 0) return;
                    setRemoveParam((prev) => {
                      const next = new Set(prev);
                      for (const pk of subGigs) next.add(pk);
                      return Array.from(next);
                    });
                    setSimResult(null);
                  }}
                  disabled={
                    contributor.links.filter((l) => l.bandwidthGbps < 1).length === 0
                  }
                  className="text-xs font-mono px-3 py-1.5 border border-cream-15 hover:border-cream-30 hover:bg-cream-8 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  − strip {"<"}1G links
                </button>
              )}

              {/* Hub triangle — top 3 activeCities with pairwise-distinct
                   defined metroCodes (only useful for new contributors). */}
              {isNewContributor && (
                <button
                  type="button"
                  onClick={() => {
                    if (!hubTrianglePicks) return;
                    const [a, b, c] = hubTrianglePicks;
                    setAddedLinks((prev) => [
                      ...prev,
                      {
                        cityA: a.locationCode,
                        cityZ: b.locationCode,
                        bandwidthGbps: 100,
                        latencyMs: 10,
                      },
                      {
                        cityA: b.locationCode,
                        cityZ: c.locationCode,
                        bandwidthGbps: 100,
                        latencyMs: 10,
                      },
                      {
                        cityA: a.locationCode,
                        cityZ: c.locationCode,
                        bandwidthGbps: 100,
                        latencyMs: 10,
                      },
                    ]);
                    setSimResult(null);
                  }}
                  disabled={!hubTrianglePicks}
                  className="text-xs font-mono px-3 py-1.5 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  + 3-city hub triangle
                </button>
              )}

              {/* 2x demand on top metro */}
              <button
                type="button"
                onClick={() => {
                  if (senderMetros.length === 0) return;
                  const top = senderMetros[0];
                  setDemandOverrides((prev) => ({
                    ...prev,
                    [top.metroCode]: top.validatorCount * 2,
                  }));
                  setShowDemandEditor(true);
                  setSimResult(null);
                }}
                disabled={senderMetros.length === 0 || !snapshot.canonicalDemand}
                className="text-xs font-mono px-3 py-1.5 border border-cream-15 hover:border-cream-30 hover:bg-cream-8 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                ↑ 2× top-metro demand
              </button>

              {/* Reset everything */}
              <button
                type="button"
                onClick={() => {
                  setAddedLinks(null);
                  setRemoveParam(null);
                  setDemandOverrides(null);
                  setSimResult(null);
                }}
                disabled={!hasChanges}
                className="text-xs font-mono px-3 py-1.5 border border-red-500/20 text-red-400 hover:bg-red-500/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed ml-auto"
              >
                ⌫ reset all
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Add new links */}
      {showAddLinks && (
        <Card className="bg-cream-5 border-cream-8">
          <CardHeader>
            <CardTitle className="font-display text-sm tracking-wide text-cream">
              {isNewContributor ? "Your links" : "Add new links"}
            </CardTitle>
            <CardDescription className="text-cream-40">
              {isNewContributor
                ? "Add the fiber routes you plan to contribute to the network"
                : "Simulate adding new fiber routes to the network"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Coverage gap suggestions */}
            {coverageGaps.length > 0 && (
              <div>
                <p className="text-xs text-cream-30 mb-2">Suggested routes:</p>
                <div className="flex flex-wrap gap-2">
                  {coverageGaps.map((gap, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setAddedLinks((prev) => [
                          ...prev,
                          {
                            cityA: gap.cityA.locationCode,
                            cityZ: gap.cityB.locationCode,
                            bandwidthGbps: newBandwidth,
                            latencyMs: newLatency,
                          },
                        ]);
                        setSimResult(null);
                      }}
                      className="flex items-center gap-1.5 rounded-full border border-cream-8 hover:border-cream-20 px-2.5 py-1 text-xs text-cream-60 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {gap.cityA.locationName}
                      <ArrowRight className="size-2.5 text-cream-20" />
                      {gap.cityB.locationName}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* City pair selectors */}
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="space-y-1.5 flex-1">
                <label className="text-xs text-cream-40">Origin</label>
                <Select value={newCityA} onValueChange={setNewCityA}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select city..." />
                  </SelectTrigger>
                  <SelectContent>
                    {activeCities.map((d) => {
                      const dl = demandLabel(d.demandScore);
                      return (
                        <SelectItem key={d.locationCode} value={d.locationCode}>
                          {d.locationName}, {d.country}
                          <span className={`ml-2 text-xs ${dl.cls}`}>{dl.text}</span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
              <ArrowRight className="size-4 text-cream-30 mb-2 hidden sm:block shrink-0" />
              <div className="space-y-1.5 flex-1">
                <label className="text-xs text-cream-40">Destination</label>
                <Select value={newCityZ} onValueChange={setNewCityZ}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select city..." />
                  </SelectTrigger>
                  <SelectContent>
                    {activeCities
                      .filter((d) => d.locationCode !== newCityA)
                      .map((d) => {
                        const dl = demandLabel(d.demandScore);
                        return (
                          <SelectItem key={d.locationCode} value={d.locationCode}>
                            {d.locationName}, {d.country}
                            <span className={`ml-2 text-xs ${dl.cls}`}>{dl.text}</span>
                          </SelectItem>
                        );
                      })}
                  </SelectContent>
                </Select>
              </div>
              <button
                onClick={addLink}
                disabled={
                  !newCityA ||
                  !newCityZ ||
                  newCityA === newCityZ ||
                  draftEndpointsSameMetro
                }
                className="rounded-lg bg-cream-8 border border-cream-15 px-4 py-2 text-sm text-cream-60 hover:text-cream hover:bg-cream-10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Plus className="size-4 inline mr-1" />
                Add
              </button>
            </div>

            {/* Intra-metro draft warning */}
            {draftEndpointsSameMetro && (
              <p className="text-xs text-amber flex items-center gap-1.5">
                <AlertTriangle className="size-3 shrink-0" />
                Intra-metro links don&apos;t earn rewards — pick locations in two different metros.
              </p>
            )}

            {/* Bandwidth + RTT */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-cream-40">Bandwidth</label>
                <div
                  role="radiogroup"
                  aria-label="Bandwidth"
                  className="inline-flex border border-cream-15 bg-surface w-full"
                >
                  {[1, 10, 100].map((g, i) => {
                    const active = newBandwidth === g;
                    return (
                      <button
                        key={g}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setNewBandwidth(g)}
                        className={`flex-1 px-3 py-2 text-xs font-mono tabular-nums transition-colors ${
                          i > 0 ? "border-l border-cream-15" : ""
                        } ${
                          active
                            ? "bg-cream text-dark"
                            : "text-cream-60 hover:text-cream"
                        }`}
                      >
                        {g}G
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="add-link-rtt"
                  className="text-xs text-cream-40"
                >
                  RTT (ms)
                </label>
                <input
                  id="add-link-rtt"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={500}
                  step={0.5}
                  value={newLatency}
                  onChange={(e) =>
                    setNewLatency(
                      Math.max(0, parseFloat(e.target.value) || 0),
                    )
                  }
                  className="w-full border border-cream-15 bg-surface px-3 py-2 text-sm font-mono tabular-nums text-cream focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                />
              </div>
            </div>

            {/* Added links list */}
            {addedLinks.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-cream-30">
                  {isNewContributor ? "Your planned links:" : "Links to add:"}
                </p>
                {addedLinks.map((link, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-lg border border-green/20 bg-green/5 px-3 py-2 text-sm"
                  >
                    <Plus className="size-3.5 text-green shrink-0" />
                    <span className="text-cream-60">{getCityName(link.cityA)}</span>
                    <ArrowRight className="size-3 text-cream-20 shrink-0" />
                    <span className="text-cream-60">{getCityName(link.cityZ)}</span>
                    <span className="ml-2 text-xs font-mono text-cream-30 tabular-nums">
                      {link.bandwidthGbps}G · {link.latencyMs}ms
                    </span>
                    {locationToMetro.get(link.cityA) !== undefined &&
                      locationToMetro.get(link.cityA) === locationToMetro.get(link.cityZ) && (
                        <span className="ml-2 text-xs text-amber font-mono shrink-0">
                          intra-metro
                        </span>
                      )}
                    <button
                      onClick={() => removeAddedLink(i)}
                      aria-label="Remove link"
                      className="ml-auto text-cream-30 hover:text-cream transition-colors rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 4: Demand profile (optional) */}
      {showAddLinks && (
        <Card className="bg-cream-5 border-cream-8">
          <CardHeader>
            <button
              type="button"
              onClick={() => setShowDemandEditor((v) => !v)}
              aria-expanded={showDemandEditor}
              className="w-full flex items-center justify-between gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded-sm"
            >
              <div>
                <CardTitle className="font-display text-sm tracking-wide text-cream">
                  Modify demand{" "}
                  <span className="text-cream-30 text-xs font-mono">
                    (optional)
                  </span>
                </CardTitle>
                <CardDescription className="text-cream-40">
                  Override validator counts per metro to see how reward share
                  changes with different demand scenarios.
                </CardDescription>
              </div>
              <span className="text-cream-30 text-xs font-mono shrink-0">
                {demandOverrideCount > 0
                  ? `${demandOverrideCount} override${demandOverrideCount > 1 ? "s" : ""}`
                  : showDemandEditor
                  ? "Hide"
                  : "Edit"}
              </span>
            </button>
          </CardHeader>
          {showDemandEditor && (
            <CardContent className="space-y-3">
              {!snapshot.canonicalDemand ? (
                <p className="text-xs text-cream-30 font-mono">
                  Demand editing requires a canonical snapshot — not available for this epoch.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs uppercase tracking-[0.14em] text-cream-30 font-mono pb-1 border-b border-cream-8">
                    <div className="sm:col-span-6">Metro</div>
                    <div className="sm:col-span-3 text-right">Current</div>
                    <div className="sm:col-span-3 text-right">Modified</div>
                  </div>
                  {/* All sender metros — the container scrolls, so no cap
                       (a hidden metro would be silently uneditable). */}
                  <div className="max-h-[280px] overflow-y-auto divide-y divide-cream-8">
                    {senderMetros.map((metro) => {
                      const current = metro.validatorCount;
                      const overrideValue = demandOverrides[metro.metroCode];
                      const inputValue =
                        overrideValue !== undefined
                          ? String(overrideValue)
                          : "";
                      return (
                        <div
                          key={metro.metroCode}
                          className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center py-2 text-sm"
                        >
                          <div className="sm:col-span-6 min-w-0">
                            <div className="text-cream truncate">
                              {metro.metroName}
                            </div>
                            <div className="text-xs text-cream-30 font-mono truncate">
                              {metro.metroCode} · {metro.locationCodes.length} location{metro.locationCodes.length === 1 ? "" : "s"}
                            </div>
                          </div>
                          <div className="sm:col-span-3 text-right text-cream-60 font-mono tabular-nums">
                            {current}
                          </div>
                          <div className="sm:col-span-3 flex items-center justify-end gap-1.5">
                            <input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              value={inputValue}
                              placeholder={String(current)}
                              onChange={(e) => {
                                const raw = e.target.value;
                                setDemandOverrides((prev) => {
                                  const next = { ...prev };
                                  if (raw === "") {
                                    delete next[metro.metroCode];
                                  } else {
                                    const n = parseInt(raw, 10);
                                    if (!Number.isNaN(n) && n >= 0) {
                                      next[metro.metroCode] = n;
                                    }
                                  }
                                  return next;
                                });
                                setSimResult(null);
                              }}
                              className="w-20 border border-cream-15 bg-surface px-2 py-1 text-xs font-mono tabular-nums text-cream text-right focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            />
                            {overrideValue !== undefined && (
                              <button
                                type="button"
                                aria-label={`Reset ${metro.metroCode}`}
                                onClick={() => {
                                  setDemandOverrides((prev) => {
                                    const next = { ...prev };
                                    delete next[metro.metroCode];
                                    return next;
                                  });
                                  setSimResult(null);
                                }}
                                className="text-cream-30 hover:text-cream transition-colors"
                              >
                                <X className="size-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {demandOverrideCount > 0 && (
                    <div className="flex items-center justify-between pt-2 border-t border-cream-8">
                      <span className="text-xs text-cream-40 font-mono">
                        {demandOverrideCount} metro override
                        {demandOverrideCount > 1 ? "s" : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setDemandOverrides(null);
                          setSimResult(null);
                        }}
                        className="text-xs text-cream-40 hover:text-cream font-mono transition-colors"
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                  <p className="text-xs text-cream-30 font-mono leading-relaxed">
                    Overrides set the validator count for a metro; the demand
                    table is regenerated from the modified counts (matching
                    mainnet ingest). Set to 0 to remove that metro&apos;s
                    validator demand entirely.
                  </p>
                </>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* Pre-flight diff preview — quick review of pending changes before
           committing to an LP run. */}
      {showAddLinks && hasChanges && !simResult && (
        <Card className="bg-cream-5 border-cream-8">
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-sm tracking-wide text-cream">
              Review changes
            </CardTitle>
            <CardDescription className="text-cream-40">
              Pending edit set vs the current network footprint.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {removedLinks.size > 0 && (
              <div className="flex items-start gap-2">
                <span className="text-red mt-0.5 font-mono shrink-0">
                  −{removedLinks.size}
                </span>
                <span className="text-cream-60">
                  link{removedLinks.size === 1 ? "" : "s"} removed
                </span>
              </div>
            )}
            {addedLinks.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="text-green mt-0.5 font-mono shrink-0">
                  +{addedLinks.length}
                </span>
                <span className="text-cream-60">
                  link{addedLinks.length === 1 ? "" : "s"} added (
                  {addedLinks.reduce((s, l) => s + l.bandwidthGbps, 0)}G total
                  capacity, {Math.round(
                    addedLinks.reduce((s, l) => s + l.latencyMs, 0) /
                      addedLinks.length,
                  )}
                  ms avg RTT)
                </span>
              </div>
            )}
            {demandOverrideCount > 0 && (
              <div className="flex items-start gap-2">
                <span className="text-amber mt-0.5 font-mono shrink-0">
                  Δ{demandOverrideCount}
                </span>
                <span className="text-cream-60">
                  metro demand override
                  {demandOverrideCount === 1 ? "" : "s"}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 5: Calculate button — sticky at the bottom of the viewport
           when there are pending changes and results haven't been computed
           against the current edit set. */}
      {showAddLinks && (
        <div
          className={
            hasChanges && !simResult
              ? "sticky bottom-3 z-30"
              : ""
          }
        >
          <div className="flex gap-2">
            <button
              onClick={() => {
                setShowJobModal(true);
                setJobState("confirming");
              }}
              disabled={!hasChanges || simLoading}
              className="flex-1 rounded-lg bg-cream text-dark font-display text-sm tracking-wide py-3 shadow-lg transition-all hover:bg-cream-80 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {hasChanges ? (
                <span className="flex items-center justify-center gap-2">
                  Calculate Impact
                  <span className="text-xs font-mono uppercase tracking-[0.14em] opacity-60">
                    {removedLinks.size > 0 && `−${removedLinks.size} `}
                    {addedLinks.length > 0 && `+${addedLinks.length} `}
                    {demandOverrideCount > 0 && `Δ${demandOverrideCount}`}
                  </span>
                </span>
              ) : (
                "Calculate Impact"
              )}
            </button>
            {hasChanges && (
              <ShareButton
                epoch={selectedEpoch}
                className="shrink-0 flex items-center gap-2 rounded-lg border border-cream-15 bg-surface px-4 py-3 text-sm font-display tracking-wide text-cream-60 shadow-lg hover:text-cream hover:border-cream-30 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              />
            )}
          </div>
        </div>
      )}

      {/* Shapley job confirmation + progress + results modal */}
      <ShapleyJobModal
        open={showJobModal}
        onOpenChange={setShowJobModal}
        onConfirm={handleConfirm}
        onCancel={handleModalCancel}
        state={jobState}
        phase={simPhase}
        percent={simPercent}
        reconnecting={simReconnecting}
        error={displaySimError(simError)}
        shareButton={
          <ShareButton
            epoch={selectedEpoch}
            className="flex items-center justify-center gap-2 rounded-lg border border-cream-15 px-5 py-2.5 text-sm text-cream-60 hover:text-cream hover:border-cream-30 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        }
        changeSummary={{
          removed: removedLinks.size,
          added: addedLinks.length,
          demandOverrides: demandOverrideCount,
        }}
        results={results}
        simResult={simResult}
        isNewContributor={isNewContributor}
        contributorCode={contributorCode}
        avgFeeSol={avgFeeSol}
        feeHistory={feeHistory}
      />

      {/* Error */}
      {simError && (
        <div className="rounded-lg bg-red/5 border border-red/20 px-3 py-2 text-xs text-red">
          {displaySimError(simError)}
        </div>
      )}

      {/* Step 5: Results */}
      {simResult && results && (
        <Card ref={resultsRef} className="bg-cream-5 border-cream-8">
          <CardHeader>
            <CardTitle className="font-display text-sm tracking-wide text-cream">
              Simulation results
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Before / Delta / After comparison */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Before */}
              <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center">
                <p className="text-xs text-cream-40 mb-1">
                  {isNewContributor ? "Before you join" : "Current share"}
                </p>
                <p className="text-2xl font-display text-cream">
                  {fmtPct(results.beforePct)}
                </p>
                {avgFeeSol > 0 && (
                  <p className="text-xs text-cream-30 mt-1 font-mono">
                    ~{formatSolFromSol(results.beforeSolEpoch, 4)} SOL / epoch
                  </p>
                )}
              </div>

              {/* Delta — derived from rounded before/after so arithmetic is visually consistent */}
              <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center flex flex-col items-center justify-center">
                <p className="text-xs text-cream-40 mb-1">Change</p>
                <div className="flex items-center gap-1">
                  {results.deltaPct > 0.001 ? (
                    <ArrowUpRight className="size-5 text-green" />
                  ) : results.deltaPct < -0.001 ? (
                    <ArrowDownRight className="size-5 text-red" />
                  ) : (
                    <Minus className="size-5 text-cream-30" />
                  )}
                  <span
                    className={`text-2xl font-display ${
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
                  <p className="text-xs text-cream-30 mt-1 font-mono">
                    {results.deltaSolEpoch >= 0 ? "+" : ""}
                    {formatSolFromSol(results.deltaSolEpoch, 4)} SOL / epoch
                  </p>
                )}
              </div>

              {/* After */}
              <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center">
                <p className="text-xs text-cream-40 mb-1">Projected share</p>
                <p className="text-2xl font-display text-cream">
                  {fmtPct(results.afterPct)}
                </p>
                {avgFeeSol > 0 && (
                  <>
                    <p className="text-xs text-cream-30 mt-1 font-mono">
                      ~{formatSolFromSol(results.afterSolEpoch, 4)} SOL / epoch
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

            {/* Monthly/Yearly projections */}
            {avgFeeSol > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center">
                  <p className="text-xs text-cream-40 mb-1">Projected monthly</p>
                  <p className="text-lg font-mono tabular-nums text-cream">
                    {formatSolFromSol(results.afterSolMonth, 2)} SOL
                  </p>
                  {!isNewContributor && (
                    <p className="text-xs text-cream-20 mt-0.5 font-mono">
                      was {formatSolFromSol(results.beforeSolMonth, 2)} SOL
                    </p>
                  )}
                </div>
                <div className="rounded-xl bg-cream-3 border border-cream-8 p-4 text-center">
                  <p className="text-xs text-cream-40 mb-1">Projected yearly</p>
                  <p className="text-lg font-mono tabular-nums text-cream">
                    {formatSolFromSol(results.afterSolYear, 2)} SOL
                  </p>
                  {results.afterSolYearUsd != null && (
                    <p className="text-xs text-cream-20 mt-0.5 font-mono">
                      ≈ {formatUsd(results.afterSolYearUsd, 0)}
                    </p>
                  )}
                  {!isNewContributor && (
                    <p className="text-xs text-cream-20 mt-0.5 font-mono">
                      was {formatSolFromSol(results.beforeSolYear, 2)} SOL
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Impact on other contributors */}
            <div>
              <p className="text-xs text-cream-40 mb-2">Impact on all contributors</p>
              <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                {simResult.allContributors
                  // Show any contributor with a non-zero share, including
                  // NEGATIVE ones: under DZ's per-city method a net-drag operator
                  // can have a negative raw Shapley share, and we surface it
                  // rather than hide it (matches DZ; no clamping — issue #19).
                  .filter((c) => c.beforeShare !== 0 || c.afterShare !== 0)
                  .sort((a, b) => b.afterShare - a.afterShare)
                  .map((c) => {
                    const bPct = roundPct(c.beforeShare);
                    const aPct = roundPct(c.afterShare);
                    const dPct = Math.round((aPct - bPct) * 100) / 100;
                    const apiCode = isNewContributor ? NEW_CONTRIBUTOR_SIM_CODE : contributorCode;
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
                          style={{ backgroundColor: getContributorColor(c.code) }}
                        />
                        <span className={`flex-1 ${isTarget ? "text-cream font-medium" : "text-cream-60"}`}>
                          {c.code === NEW_CONTRIBUTOR_SIM_CODE ? "You (new)" : getContributorDisplayName(c.code)}
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

            <p className="text-xs text-cream-20 text-center">
              Based on Shapley value analysis with historical fee averages
              {feeHistory && feeHistory.epochs.length > 0
                ? ` (epochs ${feeHistory.earliestEpoch}–${feeHistory.latestEpoch})`
                : ""}
              .
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
