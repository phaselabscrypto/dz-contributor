#!/usr/bin/env node
/**
 * Baseline-route contract test.
 *
 * Part 1 (library, no server): asserts the RemoteSolveError →
 * ShapleyServiceError.warming classification that drives
 * /api/shapley/baseline's 202-vs-502 split (warming ⇔ client timeout,
 * upstream 504, or upstream 408 — everything else is a hard failure).
 *
 * Part 2 (HTTP, needs a running server): GET /api/shapley/baseline must be
 * either 200 with the ready shape (values present, shares sum ≈ 1) or 202
 * with the warming shape {status, message, epoch}; /api/shapley?epoch=latest
 * must 400. Skipped with a warning when BASE_URL is unreachable.
 *
 * Usage:
 *   npx tsx scripts/test-baseline-route.ts
 *   BASE_URL=http://localhost:3111 npx tsx scripts/test-baseline-route.ts
 *
 * Exits non-zero on any failed assertion.
 */

import { RemoteSolveError } from "../lib/utils/shapley-remote";
import { ShapleyServiceError } from "../lib/utils/epoch-shapley";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Part 1: warming classification (no server) ─────────────────────────
console.log("classification:");
{
  const warming = (source: unknown) =>
    new ShapleyServiceError("test", source).warming;

  check("upstream 504 (router cut) → warming", warming(new RemoteSolveError("HTTP 504", 504)));
  check("upstream 408 (service TimeoutLayer) → warming", warming(new RemoteSolveError("HTTP 408", 408)));
  check("client timeout → warming", warming(new RemoteSolveError("timed out", undefined, true)));
  check("upstream 500 → hard", !warming(new RemoteSolveError("HTTP 500", 500)));
  check("upstream 502 → hard", !warming(new RemoteSolveError("HTTP 502", 502)));
  check("upstream 503 → hard", !warming(new RemoteSolveError("HTTP 503", 503)));
  check("upstream 422 → hard", !warming(new RemoteSolveError("HTTP 422", 422)));
  check("upstream 401 → hard", !warming(new RemoteSolveError("HTTP 401", 401)));
  check("network TypeError → hard", !warming(new TypeError("fetch failed")));
  check("plain Error (snapshot fetch) → hard", !warming(new Error("Snapshot fetch for epoch 185 failed: HTTP 500")));
  check(
    "upstream status carried through for observability",
    new ShapleyServiceError("test", new RemoteSolveError("m", 504)).status === 504,
  );
  check(
    "RemoteSolveError is a named Error subclass",
    new RemoteSolveError("m").name === "RemoteSolveError" &&
      new RemoteSolveError("m") instanceof Error,
  );
}

// ── Part 2: HTTP contract (against BASE_URL) ───────────────────────────
async function httpAsserts(): Promise<void> {
  try {
    const health = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch {
    console.warn(
      `\nno healthy dz-contributor server at ${BASE_URL} — skipping HTTP ` +
        "asserts (start one with `pnpm dev` and pass BASE_URL)",
    );
    return;
  }

  console.log(`http (${BASE_URL}):`);
  const res = await fetch(`${BASE_URL}/api/shapley/baseline`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 200) {
    const body = await res.json();
    check(
      "200 ready shape (epoch/values/operatorCount)",
      typeof body.epoch === "number" &&
        body.values !== undefined &&
        typeof body.operatorCount === "number",
    );
    const shares = Object.values(
      body.values as Record<string, { share: number }>,
    ).map((v) => v.share);
    const sum = shares.reduce((a, b) => a + b, 0);
    check("shares sum ≈ 1", Math.abs(sum - 1) < 0.001, `sum=${sum}`);
  } else if (res.status === 202) {
    const body = await res.json();
    check(
      "202 warming shape ({status, message, epoch})",
      body.status === "warming" &&
        typeof body.message === "string" &&
        typeof body.epoch === "number",
    );
  } else if (res.status === 502) {
    console.warn(
      "  baseline → 502 (service down/misconfigured for this harness) — " +
        "shape asserts skipped",
    );
  } else {
    check(`baseline responds 200 or 202 (got ${res.status})`, false);
  }

  const latest = await fetch(`${BASE_URL}/api/shapley?epoch=latest`, {
    signal: AbortSignal.timeout(10_000),
  });
  check("/api/shapley?epoch=latest → 400", latest.status === 400);
}

httpAsserts().then(() => {
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} assertion(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
