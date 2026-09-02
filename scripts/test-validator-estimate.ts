#!/usr/bin/env node
/**
 * Validator earnings math tests (`lib/utils/reward-estimator.ts`).
 *
 * Two jobs.
 *
 * The parity gate asserts `computeValidatorRewards` produces byte-identical
 * output against a committed fixture. That function feeds the /validators
 * table and its 17-column CSV export, and the DoubleZero Foundation has
 * already reviewed those numbers, so a refactor moving them is a defect. The
 * expected file was captured from the implementation before
 * `estimateValidatorTake` was extracted.
 *
 * The unit assertions cover `estimateValidatorTake` directly, including the
 * counterfactual denominator and the `countedInEligibleStake` guard, which is
 * the one input that turns a correct answer into a plausible wrong one.
 *
 * Pure — no network, no solver. The epoch rate is pinned to
 * FALLBACK_EPOCH_RATE so the assertions never depend on a live RPC read.
 *
 * Usage:
 *   npx tsx scripts/test-validator-estimate.ts
 *
 * Exits non-zero on any failed assertion.
 */

import { readFileSync } from "node:fs";

import {
  computeValidatorRewards,
  estimateValidatorTake,
  isPublisherEligible,
  sumEligibleStakeLamports,
} from "../lib/utils/reward-estimator";
import { FALLBACK_EPOCH_RATE } from "../lib/utils/epoch-rate";
import { LAMPORTS_PER_SOL } from "../lib/constants/config";
import type { PublisherCheckResponse } from "../lib/types/publisher";

// Must match the value the expected fixture was captured with.
const AVG_FEE_SOL = 1234.56789;

const FIXTURE = "scripts/fixtures/publishers-parity.json";
const EXPECTED = "scripts/fixtures/validator-rewards-expected.json";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function paritySection() {
  console.log("parity gate — /validators output must not move:");
  const fixture = readJson<PublisherCheckResponse>(FIXTURE);
  const expected = readJson<ReturnType<typeof computeValidatorRewards>>(
    EXPECTED,
  );
  const actual = computeValidatorRewards(
    fixture,
    AVG_FEE_SOL,
    FALLBACK_EPOCH_RATE,
  );

  check(
    "row count matches",
    actual.validators.length === expected.validators.length,
    `${actual.validators.length} vs ${expected.validators.length}`,
  );
  check(
    "publishingValidatorCount matches",
    actual.publishingValidatorCount === expected.publishingValidatorCount,
    `${actual.publishingValidatorCount} vs ${expected.publishingValidatorCount}`,
  );
  check(
    "totalPublishingStake matches exactly",
    actual.totalPublishingStake === expected.totalPublishingStake,
    `${actual.totalPublishingStake} vs ${expected.totalPublishingStake}`,
  );
  check(
    "projectedValidatorPoolPerEpochSol matches exactly",
    actual.projectedValidatorPoolPerEpochSol ===
      expected.projectedValidatorPoolPerEpochSol,
  );

  // Per-row, per-column. A single aggregate comparison would let one row's
  // error cancel another's.
  const columns = [
    "stakeSharePercent",
    "projectedRewardPerEpochSol",
    "projectedRewardMonthlySol",
    "projectedRewardYearlySol",
  ] as const;
  let mismatches = 0;
  for (const [i, exp] of expected.validators.entries()) {
    const act = actual.validators[i];
    if (!act || act.nodePubkey !== exp.nodePubkey) {
      mismatches += 1;
      continue;
    }
    for (const col of columns) {
      if (act[col] !== exp[col]) mismatches += 1;
    }
  }
  check(
    `all ${expected.validators.length} rows match on ${columns.length} numeric columns, and sort order is stable`,
    mismatches === 0,
    `${mismatches} mismatched value(s)`,
  );

  check(
    "serialised output is byte-identical",
    JSON.stringify(actual) === JSON.stringify(expected),
  );
}

function eligibilitySection() {
  console.log("isPublisherEligible — all four flag combinations:");
  const cases: Array<[boolean, boolean, boolean]> = [
    [true, false, true],
    [true, true, false],
    [false, false, false],
    [false, true, false],
  ];
  for (const [shreds, retrans, want] of cases) {
    const got = isPublisherEligible({
      publishing_leader_shreds: shreds,
      publishing_retransmitted: retrans,
    });
    check(
      `shreds=${shreds} retransmit=${retrans} → ${want}`,
      got === want,
      String(got),
    );
  }

  const fixture = readJson<PublisherCheckResponse>(FIXTURE);
  const hasRetransmitter = fixture.publishers.some(
    (p) => p.publishing_retransmitted,
  );
  check(
    "the fixture actually covers a retransmitting publisher",
    hasRetransmitter,
    "add one — the live feed often has none, so the branch goes untested",
  );

  const manual = fixture.publishers
    .filter((p) => p.publishing_leader_shreds && !p.publishing_retransmitted)
    .reduce((s, p) => s + p.activated_stake, 0);
  check(
    "sumEligibleStakeLamports agrees with a hand-rolled sum",
    sumEligibleStakeLamports(fixture) === manual,
  );
}

function estimateSection() {
  console.log("estimateValidatorTake — the counterfactual:");
  const S = 30_000_000 * LAMPORTS_PER_SOL;
  const x = 3_000_000 * LAMPORTS_PER_SOL;

  const joining = estimateValidatorTake({
    activatedStakeLamports: x,
    eligibleStakeLamports: S,
    countedInEligibleStake: false,
    averageFeeSol: 1_000,
    epochs: FALLBACK_EPOCH_RATE,
  });
  // x / (S + x) = 3/33 = 0.0909...
  check(
    "3M SOL joining a 30M SOL pool → 9.0909% share",
    near(joining.stakeShare, 3 / 33, 1e-12),
    joining.stakeShare.toFixed(10),
  );
  check(
    "the subject's stake entered the denominator",
    joining.eligibleStakeLamports === S + x,
  );

  const alreadyIn = estimateValidatorTake({
    activatedStakeLamports: x,
    eligibleStakeLamports: S,
    countedInEligibleStake: true,
    averageFeeSol: 1_000,
    epochs: FALLBACK_EPOCH_RATE,
  });
  check(
    "an already-eligible validator → 10% share, denominator untouched",
    near(alreadyIn.stakeShare, 0.1, 1e-12) &&
      alreadyIn.eligibleStakeLamports === S,
    alreadyIn.stakeShare.toFixed(10),
  );
  // The guard is the whole reason the flag is explicit: getting it wrong
  // yields a believable wrong number, not a crash.
  check(
    "the two differ, so the guard is load-bearing",
    joining.stakeShare !== alreadyIn.stakeShare,
  );
  check(
    "double-counting would understate the subject by 9.09%",
    near(1 - joining.stakeShare / alreadyIn.stakeShare, 1 / 11, 1e-12),
  );

  console.log("estimateValidatorTake — null fee feed:");
  const noFee = estimateValidatorTake({
    activatedStakeLamports: x,
    eligibleStakeLamports: S,
    countedInEligibleStake: true,
    averageFeeSol: null,
    epochs: FALLBACK_EPOCH_RATE,
  });
  check("validatorPoolSol is null", noFee.validatorPoolSol === null);
  check("perEpochSol is null, not 0", noFee.perEpochSol === null);
  check("monthlySol is null, not 0", noFee.monthlySol === null);
  check("yearlySol is null, not 0", noFee.yearlySol === null);
  check(
    "stakeShare is still a real number",
    near(noFee.stakeShare, 0.1, 1e-12),
  );

  console.log("estimateValidatorTake — degenerate inputs:");
  const zeroBoth = estimateValidatorTake({
    activatedStakeLamports: 0,
    eligibleStakeLamports: 0,
    countedInEligibleStake: false,
    averageFeeSol: 1_000,
    epochs: FALLBACK_EPOCH_RATE,
  });
  check(
    "zero stake and zero pool → 0 share, no NaN",
    zeroBoth.stakeShare === 0 && Number.isFinite(zeroBoth.perEpochSol ?? 0),
  );

  const zeroStake = estimateValidatorTake({
    activatedStakeLamports: 0,
    eligibleStakeLamports: S,
    countedInEligibleStake: false,
    averageFeeSol: 1_000,
    epochs: FALLBACK_EPOCH_RATE,
  });
  check("an unstaked validator earns 0", zeroStake.perEpochSol === 0);

  console.log("estimateValidatorTake — the published formula:");
  const e = estimateValidatorTake({
    activatedStakeLamports: x,
    eligibleStakeLamports: S,
    countedInEligibleStake: true,
    averageFeeSol: 1_000,
    epochs: FALLBACK_EPOCH_RATE,
  });
  // pool = 1000 x 0.45 = 450; take = 0.1 x 450 x 0.65 = 29.25
  check("pool = avgFee x 0.45", near(e.validatorPoolSol ?? 0, 450, 1e-9));
  check(
    "take = share x pool x 0.65",
    near(e.perEpochSol ?? 0, 29.25, 1e-9),
    String(e.perEpochSol),
  );
  check(
    "monthly = perEpoch x epochs.perMonth",
    near(e.monthlySol ?? 0, 29.25 * FALLBACK_EPOCH_RATE.perMonth, 1e-9),
  );
  check(
    "yearly = perEpoch x epochs.perYear",
    near(e.yearlySol ?? 0, 29.25 * FALLBACK_EPOCH_RATE.perYear, 1e-9),
  );
}

function main() {
  paritySection();
  eligibilitySection();
  estimateSection();

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall assertions passed");
}

main();
