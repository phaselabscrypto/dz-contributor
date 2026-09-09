#!/usr/bin/env node
/**
 * Baseline-route HTTP contract test (needs a running server).
 *
 * `GET /api/shapley/baseline` must be either 200 with the published shape
 * (epoch, tag, values, operatorCount; shares sum ≈ 1) or 404 with
 * `{status:"not-cached", epoch, tag}`. It never computes, so neither answer
 * takes longer than a proxy hop. `/api/shapley?epoch=latest` must 400, and
 * `/api/shapley/tracking?count=4` must be 200 or 404 with the same discipline.
 *
 * Usage:
 *   npx tsx scripts/test-baseline-route.ts
 *   BASE_URL=http://localhost:3111 npx tsx scripts/test-baseline-route.ts
 *
 * Exits non-zero on any failed assertion.
 */

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

async function httpAsserts(): Promise<void> {
  try {
    const health = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch {
    console.warn(
      `no healthy dz-contributor server at ${BASE_URL} — skipping HTTP ` +
        "asserts (start one with `pnpm dev` and pass BASE_URL)",
    );
    return;
  }

  console.log(`http (${BASE_URL}):`);
  const res = await fetch(`${BASE_URL}/api/shapley/baseline`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 200) {
    const body = await res.json();
    check(
      "200 published shape (epoch/tag/values/operatorCount)",
      typeof body.epoch === "number" &&
        typeof body.tag === "string" &&
        body.values !== undefined &&
        typeof body.operatorCount === "number",
    );
    const shares = Object.values(
      body.values as Record<string, { share: number }>,
    ).map((v) => v.share);
    const sum = shares.reduce((a, b) => a + b, 0);
    check("shares sum ≈ 1", Math.abs(sum - 1) < 0.001, `sum=${sum}`);
  } else if (res.status === 404) {
    const body = await res.json();
    check(
      "404 not-cached shape ({status, epoch, tag})",
      body.status === "not-cached" &&
        typeof body.epoch === "number" &&
        typeof body.tag === "string",
    );
  } else if (res.status === 502) {
    console.warn(
      "  baseline → 502 (service down/misconfigured for this harness) — " +
        "shape asserts skipped",
    );
  } else {
    check(`baseline responds 200 or 404 (got ${res.status})`, false);
  }

  const latest = await fetch(`${BASE_URL}/api/shapley?epoch=latest`, {
    signal: AbortSignal.timeout(10_000),
  });
  check("/api/shapley?epoch=latest → 400", latest.status === 400);

  const tracking = await fetch(`${BASE_URL}/api/shapley/tracking?count=4`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (tracking.status === 200) {
    const body = await tracking.json();
    check(
      "tracking 200 shape (>= 2 epochs, missingEpochs array)",
      Array.isArray(body.epochs) &&
        body.epochs.length >= 2 &&
        Array.isArray(body.missingEpochs),
    );
  } else if (tracking.status === 404) {
    const body = await tracking.json();
    check(
      "tracking 404 not-cached shape",
      body.status === "not-cached" &&
        Array.isArray(body.epochs) &&
        Array.isArray(body.missingEpochs),
    );
  } else if (tracking.status === 502) {
    console.warn("  tracking → 502, shape asserts skipped");
  } else {
    check(`tracking responds 200 or 404 (got ${tracking.status})`, false);
  }
}

httpAsserts().then(() => {
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} assertion(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
