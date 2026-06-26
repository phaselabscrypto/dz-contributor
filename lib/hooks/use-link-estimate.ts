"use client";

import { useEffect, useState } from "react";
import type { LinkEstimateLink } from "@/lib/utils/shapley-remote";

/** Poll cadence + transient-failure budget — mirrors simulate-tab's policy. */
const POLL_INTERVAL_MS = 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 20;

/** Peel nested `{ "error": "… {\"error\":\"<msg>\"}" }` wrappers (the Next proxy
 * and the Rust service each wrap the message) down to the innermost human text. */
function cleanError(body: string): string {
  let msg = body.slice(0, 600);
  for (let i = 0; i < 3; i += 1) {
    const m = msg.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) break;
    msg = m[1].replace(/\\(.)/g, "$1");
  }
  return msg.slice(0, 240);
}

/** A completed canonical link-estimate run for one (contributor, epoch). */
export interface LinkEstimateData {
  epoch: number;
  method: string;
  operatorFocus: string;
  links: LinkEstimateLink[];
}

export interface LinkEstimateState {
  /** Completed canonical result for the CURRENT (contributor, epoch) pair. */
  data: LinkEstimateData | null;
  /** Hard failure for the current pair — there is NO fallback; show it. */
  error: string | null;
  /** True when `error` is a deterministic rejection (4xx / failed job) a retry
   * can't fix — callers should present it as terminal, not "try again". */
  terminal: boolean;
  /** Live solve progress 0–100 while a job is running (null otherwise). */
  progress: number | null;
  /** True while submitting/polling for the current pair. */
  loading: boolean;
}

/**
 * Canonical per-link Shapley values via the async job API: submit → poll →
 * done/error. NO approximate fallback — any failure surfaces as `error` and
 * callers must render it as such (policy: canonical data comes from the
 * precompute cache, a job computes it, or the UI errors loudly).
 *
 * Precomputed (epoch-swept) pairs complete at submit time, so the first poll
 * returns instantly. Transient poll blips get a bounded retry budget; exhausting
 * it cancels the job and errors. Unmount/selection change cancels the job.
 */
export function useLinkEstimate(
  contributor: string | null,
  epoch: number | null,
): LinkEstimateState {
  const [fetchState, setFetchState] = useState<{
    contributor: string;
    epoch: number | null;
    data: LinkEstimateData | null;
    error: string | null;
    terminal: boolean;
    inFlight: boolean;
    progress: number | null;
  }>({
    contributor: "",
    epoch: null,
    data: null,
    error: null,
    terminal: false,
    inFlight: false,
    progress: null,
  });

  useEffect(() => {
    if (!contributor || !epoch) return;
    let cancelled = false;
    let jobId: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollFailures = 0;
    const runId = { contributor, epoch };

    const cancelJob = () => {
      if (jobId) {
        void fetch(`/api/link-value/jobs/${jobId}`, { method: "DELETE" }).catch(
          () => {},
        );
      }
    };
    const fail = (msg: string, terminal = false) => {
      if (cancelled) return;
      setFetchState({
        ...runId,
        data: null,
        error: msg,
        terminal,
        inFlight: false,
        progress: null,
      });
    };
    const succeed = (json: LinkEstimateData) => {
      if (cancelled) return;
      setFetchState({
        ...runId,
        data: json,
        error: null,
        terminal: false,
        inFlight: false,
        progress: null,
      });
    };
    const setProgress = (percent: number) => {
      setFetchState((s) =>
        s.contributor === runId.contributor && s.epoch === runId.epoch
          ? { ...s, progress: percent }
          : s,
      );
    };
    // A transient poll blip (proxy 500, network drop) must not discard a
    // running multi-minute solve; retry up to the budget, then cancel the job
    // and error hard.
    const retryOrAbandon = (msg: string) => {
      if (cancelled) return;
      pollFailures += 1;
      if (pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        cancelJob();
        fail(
          `polling failed ${pollFailures}x — gave up and cancelled the job (${msg})`,
        );
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    const poll = async () => {
      if (cancelled || !jobId) return;
      try {
        const res = await fetch(`/api/link-value/jobs/${jobId}`);
        if (cancelled) return;
        if (!res.ok) {
          return retryOrAbandon(
            `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`,
          );
        }
        pollFailures = 0;
        const j = (await res.json()) as {
          state: string;
          progress?: { percent?: number } | null;
          method?: string;
          operatorFocus?: string;
          links?: LinkEstimateLink[];
          error?: string | null;
        };
        if (cancelled) return;
        if (j.state === "done") {
          // The proxy already converts done-without-result into "failed";
          // belt-and-braces so a malformed payload can never present as a
          // successful canonical run.
          if (!Array.isArray(j.links)) {
            return fail("job finished but returned no result", true);
          }
          succeed({
            epoch: runId.epoch,
            method: j.method ?? "",
            operatorFocus: j.operatorFocus ?? runId.contributor,
            links: j.links,
          });
          return;
        }
        if (j.state === "failed" || j.state === "cancelled") {
          // A failed/cancelled job is a deterministic outcome for this input.
          return fail(j.error ? String(j.error).slice(0, 200) : j.state, true);
        }
        if (typeof j.progress?.percent === "number") {
          setProgress(j.progress.percent);
        }
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (e) {
        retryOrAbandon(e instanceof Error ? e.message : "poll failed");
      }
    };

    (async () => {
      // Mark the current pair in-flight (kept out of the effect body so we never
      // call setState synchronously during render — see react-hooks lint).
      if (!cancelled) {
        setFetchState({
          ...runId,
          data: null,
          error: null,
          terminal: false,
          inFlight: true,
          progress: 0,
        });
      }
      try {
        const res = await fetch("/api/link-value/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            epoch: runId.epoch,
            contributorCode: runId.contributor,
          }),
        });
        if (!res.ok) {
          if (cancelled) return;
          // A 4xx is a deterministic rejection (e.g. the operator owns more
          // links than the exact breakdown can solve) — surface the service's
          // own message as TERMINAL, never as a transient "try again".
          const body = await res.text();
          const terminal = res.status >= 400 && res.status < 500;
          return fail(cleanError(body), terminal);
        }
        // Capture the job id BEFORE any cancelled-check: the job already exists
        // server-side, so an early return here (selection change mid-POST,
        // StrictMode double-invoke) would orphan an uncancellable solve.
        const { jobId: id } = (await res.json()) as { jobId: string };
        jobId = id;
        if (cancelled) {
          cancelJob();
          return;
        }
        void poll();
      } catch (e) {
        if (cancelled) return;
        fail(e instanceof Error ? e.message : "Unknown error");
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // Best-effort: free the worker if we navigated away mid-solve.
      cancelJob();
    };
  }, [contributor, epoch]);

  // Only honor fetched state if it matches the current inputs; otherwise
  // we're still loading the new pair.
  const isCurrent =
    fetchState.contributor === contributor && fetchState.epoch === epoch;
  return {
    data: isCurrent && !fetchState.inFlight ? fetchState.data : null,
    error: isCurrent ? fetchState.error : null,
    terminal: isCurrent ? fetchState.terminal : false,
    progress: isCurrent ? fetchState.progress : null,
    loading: !!contributor && !!epoch && (!isCurrent || fetchState.inFlight),
  };
}

/**
 * Canonical link rows are keyed by ENGINE DEVICE NAMES (`FRA1`, `AMS2`); the
 * live topology keys links by metro code (`fra`). Normalize both sides to a
 * lowercased, digit-stripped, sorted metro pair so they actually join.
 */
export function metroPairKey(a: string, b: string): string {
  const metro = (s: string) => s.replace(/\d+$/, "").toLowerCase();
  return [metro(a), metro(b)].sort().join("|");
}

/** Index canonical rows by normalized metro pair (first match wins; parallel
 * links between the same metros share the consolidated canonical row). */
export function canonicalByMetroPair(
  links: LinkEstimateLink[],
): Map<string, LinkEstimateLink> {
  const m = new Map<string, LinkEstimateLink>();
  for (const l of links) {
    const k = metroPairKey(l.device1, l.device2);
    if (!m.has(k)) m.set(k, l);
  }
  return m;
}
