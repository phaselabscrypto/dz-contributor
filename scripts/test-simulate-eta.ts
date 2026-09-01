#!/usr/bin/env node
/**
 * Simulate progress helpers: the rolling ETA estimator, duration copy, and
 * the per-browser run history (`lib/utils/eta.ts`, `lib/utils/format.ts`,
 * `lib/utils/run-history.ts`).
 *
 * The estimator cases replay the two distortions measured on the live
 * service: a counter pinned at 0 while a cold baseline primes, and an
 * instant jump when the modified phase credits reused cities. Both must
 * leave the estimate unaffected.
 *
 * Pure. No snapshot, no network.
 *
 * Usage:
 *   npx tsx scripts/test-simulate-eta.ts
 *
 * Exits non-zero on any failed assertion.
 */

import {
  advanceEta,
  etaLabel,
  INITIAL_ETA_STATE,
  type EtaState,
} from "../lib/utils/eta";
import { formatDuration, formatElapsed } from "../lib/utils/format";
import {
  pushRun,
  typicalRuntimeLabel,
  RUNTIME_FALLBACK_LABEL,
  RUN_HISTORY_MAX,
  type RunRecord,
} from "../lib/utils/run-history";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function feed(
  start: EtaState,
  samples: Array<[t: number, solved: number, total: number, phase?: string]>,
): EtaState {
  return samples.reduce(
    (s, [t, solved, total, phase]) =>
      advanceEta(s, { phase: phase ?? "modified", nowMs: t, solved, total }),
    start,
  );
}

console.log("advanceEta");
{
  // Nothing before both thresholds are met.
  let s = feed(INITIAL_ETA_STATE, [
    [0, 10, 1000],
    [1000, 15, 1000],
    [2000, 20, 1000],
  ]);
  check("no estimate under 5s", s.smoothedRemainingMs === null);
  s = feed(INITIAL_ETA_STATE, [
    [0, 10, 1000],
    [6000, 15, 1000],
  ]);
  check("no estimate under 2% progress", s.smoothedRemainingMs === null);

  // Constant rate: 10 units/s over 1000 units, sampled every second.
  s = INITIAL_ETA_STATE;
  for (let i = 0; i <= 10; i++) s = feed(s, [[i * 1000, 10 + i * 10, 1000]]);
  const expected = ((1000 - 110) / 10) * 1000;
  check(
    "constant rate estimate within 1%",
    s.smoothedRemainingMs !== null &&
      Math.abs(s.smoothedRemainingMs - expected) / expected < 0.01,
    `got ${s.smoothedRemainingMs}, want ${expected}`,
  );

  // Reused-city jump: 80% credited at t=1s, then 10 units/s.
  s = feed(INITIAL_ETA_STATE, [[1000, 800, 1000]]);
  for (let i = 1; i <= 10; i++) s = feed(s, [[1000 + i * 1000, 800 + i * 10, 1000]]);
  const remainingUnits = 1000 - 900;
  const wantJump = (remainingUnits / 10) * 1000;
  check(
    "instant jump does not shrink the estimate",
    s.smoothedRemainingMs !== null &&
      Math.abs(s.smoothedRemainingMs - wantJump) / wantJump < 0.01,
    `got ${s.smoothedRemainingMs}, want ${wantJump}`,
  );

  // Priming window: counter at 0 for a while, then live.
  s = feed(INITIAL_ETA_STATE, [
    [0, 0, 1000],
    [1000, 0, 1000],
    [2000, 0, 1000],
  ]);
  check("zero progress sets no anchor", s.anchor === null);
  s = feed(s, [[3000, 10, 1000]]);
  check("first live sample anchors", s.anchor?.t === 3000 && s.anchor?.solved === 10);

  // Phase change resets anchor and smoothing.
  s = INITIAL_ETA_STATE;
  for (let i = 0; i <= 10; i++)
    s = feed(s, [[i * 1000, 10 + i * 10, 1000, "baseline"]]);
  check("baseline phase produced an estimate", s.smoothedRemainingMs !== null);
  s = feed(s, [[11000, 5, 5000, "modified"]]);
  check(
    "phase flip re-anchors",
    s.phase === "modified" &&
      s.total === 5000 &&
      s.smoothedRemainingMs === null &&
      s.anchor?.solved === 5,
  );

  // Counter going backwards with the same phase label re-anchors.
  s = INITIAL_ETA_STATE;
  for (let i = 0; i <= 10; i++) s = feed(s, [[i * 1000, 10 + i * 10, 1000]]);
  s = feed(s, [[11000, 3, 1000]]);
  check("solved decreasing re-anchors", s.smoothedRemainingMs === null && s.anchor?.solved === 3);

  // Denominator change re-anchors.
  s = INITIAL_ETA_STATE;
  for (let i = 0; i <= 10; i++) s = feed(s, [[i * 1000, 10 + i * 10, 1000]]);
  s = feed(s, [[11000, 120, 2000]]);
  check("total change re-anchors", s.smoothedRemainingMs === null && s.total === 2000);

  // Completion clears nothing but stops updating.
  s = INITIAL_ETA_STATE;
  for (let i = 0; i <= 10; i++) s = feed(s, [[i * 1000, 10 + i * 10, 1000]]);
  const before = s.smoothedRemainingMs;
  s = feed(s, [[11000, 1000, 1000]]);
  check("solved == total leaves state unchanged", s.smoothedRemainingMs === before);

  check("etaLabel null without estimate", etaLabel(INITIAL_ETA_STATE) === null);
  check(
    "etaLabel formats remaining",
    etaLabel({ ...INITIAL_ETA_STATE, smoothedRemainingMs: 6 * 60_000 }) === "about 6 min left",
  );
}

console.log("formatDuration");
{
  check("59s", formatDuration(59_000) === "under a minute");
  check("60s", formatDuration(60_000) === "about 1 min");
  check("59.5 min rounds up", formatDuration(59.5 * 60_000) === "about 60 min" || formatDuration(59.5 * 60_000) === "about 1h 0m");
  check("61 min", formatDuration(61 * 60_000) === "about 1h 1m");
  check("negative is safe", formatDuration(-5) === "under a minute");
  check("NaN is safe", formatDuration(Number.NaN) === "under a minute");
}

console.log("formatElapsed");
{
  check("seconds", formatElapsed(42_000) === "42s");
  check("minutes", formatElapsed(252_000) === "4m 12s");
  check("hours", formatElapsed(64 * 60_000) === "1h 04m");
  check("negative is safe", formatElapsed(-1) === "0s");
}

console.log("run history");
{
  const rec = (totalMs: number): RunRecord => ({
    totalMs,
    baselineCacheHit: true,
    epoch: 200,
    finishedAt: "2026-09-02T00:00:00.000Z",
  });
  let h: RunRecord[] = [];
  for (let i = 1; i <= 7; i++) h = pushRun(h, rec(i * 60_000));
  check("capped at max", h.length === RUN_HISTORY_MAX);
  check("newest first", h[0].totalMs === 7 * 60_000 && h[4].totalMs === 3 * 60_000);
  check("fallback when empty", typicalRuntimeLabel([]) === RUNTIME_FALLBACK_LABEL);
  check(
    "odd median",
    typicalRuntimeLabel([rec(2 * 60_000), rec(9 * 60_000), rec(4 * 60_000)]) ===
      "Recent runs took about 4 min",
  );
  check(
    "even median",
    typicalRuntimeLabel([rec(2 * 60_000), rec(10 * 60_000)]) ===
      "Recent runs took about 6 min",
  );
  check(
    "ignores bad durations",
    typicalRuntimeLabel([rec(0), rec(Number.NaN), rec(3 * 60_000)]) ===
      "Recent runs took about 3 min",
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
