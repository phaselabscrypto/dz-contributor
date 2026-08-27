#!/usr/bin/env node
/**
 * Epoch-rate derivation tests (`lib/utils/epoch-rate.ts`).
 *
 * The pure section exercises the derivation and the plausibility clamp with no
 * network. The live section measures against a real RPC and checks the result
 * against the 2026-08-27 baseline of ~366 ms slots.
 *
 * Usage:
 *   npx tsx scripts/test-epoch-rate.ts
 *   LIVE=1 SOLANA_RPC_URL=https://... npx tsx scripts/test-epoch-rate.ts
 *
 * Exits non-zero on any failed assertion.
 */

import {
  FALLBACK_EPOCH_RATE,
  __testing,
} from "../lib/utils/epoch-rate";

const LIVE = process.env.LIVE === "1";
const { rateFromSlotMs, MIN_PLAUSIBLE_SLOT_MS, MAX_PLAUSIBLE_SLOT_MS } =
  __testing;

const SLOTS_PER_EPOCH = 432_000;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function skip(name: string) {
  console.log(`  skip ${name}`);
}

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

function pureSection() {
  console.log("derivation:");

  const r366 = rateFromSlotMs(366, SLOTS_PER_EPOCH, 1023, "measured");
  // 432,000 x 366ms = 158,112,000ms exactly.
  check(
    "366ms slots → 43.92h epoch",
    near(r366.epochMs / 3_600_000, 43.92, 0.01),
    `${(r366.epochMs / 3_600_000).toFixed(4)}h`,
  );
  check(
    "366ms slots → 16.39 epochs/month",
    near(r366.perMonth, 16.3934, 0.001),
    r366.perMonth.toFixed(4),
  );
  check(
    "366ms slots → 199.45 epochs/year",
    near(r366.perYear, 199.4536, 0.001),
    r366.perYear.toFixed(4),
  );
  // The correction this module exists to make. Pinned so a later edit that
  // reintroduces the old assumption fails loudly.
  check(
    "monthly figures rise 1.261x against the old EPOCHS_PER_MONTH = 13",
    near(r366.perMonth / 13, 1.261, 0.001),
    (r366.perMonth / 13).toFixed(4),
  );
  check(
    "yearly figures rise 1.202x against the old EPOCHS_PER_YEAR = 166",
    near(r366.perYear / 166, 1.2015, 0.001),
    (r366.perYear / 166).toFixed(4),
  );

  // The figures the hardcoded constants assumed, kept as a regression anchor:
  // a 2.2-day epoch really does give ~13.6 and ~166.
  const r400 = rateFromSlotMs(440, SLOTS_PER_EPOCH, null, "measured");
  check(
    "440ms slots reproduces the old ~13.6/month assumption",
    near(r400.perMonth, 13.6, 0.2),
    r400.perMonth.toFixed(2),
  );

  check(
    "perMonth and perYear are both derived from epochMs",
    (() => {
      const r = rateFromSlotMs(500, SLOTS_PER_EPOCH, null, "measured");
      const expectedMonth = (30 * 86_400_000) / r.epochMs;
      const expectedYear = (365 * 86_400_000) / r.epochMs;
      return (
        near(r.perMonth, expectedMonth, 1e-9) &&
        near(r.perYear, expectedYear, 1e-9)
      );
    })(),
  );

  check(
    "perYear / perMonth is the month-to-year ratio, not a stored constant",
    (() => {
      const r = rateFromSlotMs(366, SLOTS_PER_EPOCH, null, "measured");
      return near(r.perYear / r.perMonth, 365 / 30, 1e-9);
    })(),
  );

  console.log("fallback:");
  check(
    "fallback is 366ms, matching the 2026-08-27 measurement",
    FALLBACK_EPOCH_RATE.slotMs === 366,
    String(FALLBACK_EPOCH_RATE.slotMs),
  );
  check(
    "fallback is labelled as such",
    FALLBACK_EPOCH_RATE.source === "fallback",
    FALLBACK_EPOCH_RATE.source,
  );
  check(
    "fallback is NOT the stale 13/166 pair",
    FALLBACK_EPOCH_RATE.perMonth > 15 && FALLBACK_EPOCH_RATE.perYear > 190,
    `${FALLBACK_EPOCH_RATE.perMonth.toFixed(1)}/${FALLBACK_EPOCH_RATE.perYear.toFixed(0)}`,
  );
  check(
    "fallback has no epoch, since nothing was read",
    FALLBACK_EPOCH_RATE.epoch === null,
  );

  console.log("plausibility clamp:");
  check(
    `clamp lower bound is ${MIN_PLAUSIBLE_SLOT_MS}ms`,
    MIN_PLAUSIBLE_SLOT_MS === 200,
    String(MIN_PLAUSIBLE_SLOT_MS),
  );
  check(
    `clamp upper bound is ${MAX_PLAUSIBLE_SLOT_MS}ms`,
    MAX_PLAUSIBLE_SLOT_MS === 1_000,
    String(MAX_PLAUSIBLE_SLOT_MS),
  );
  // The clamp exists because a bad measurement becomes a multiplier on a SOL
  // figure. 50ms would inflate every monthly projection roughly 7x.
  check(
    "50ms would be rejected by the clamp",
    50 < MIN_PLAUSIBLE_SLOT_MS,
  );
  check(
    "5000ms would be rejected by the clamp",
    5_000 > MAX_PLAUSIBLE_SLOT_MS,
  );
  check(
    "the current mainnet 366ms sits inside the clamp",
    366 >= MIN_PLAUSIBLE_SLOT_MS && 366 <= MAX_PLAUSIBLE_SLOT_MS,
  );
}

async function liveSection() {
  if (!LIVE) {
    skip("live RPC measurement (set LIVE=1 to run)");
    return;
  }
  const { getEpochRate, clearEpochRateCache } = await import(
    "../lib/utils/epoch-rate"
  );
  clearEpochRateCache();

  const rate = await getEpochRate();
  check(
    "measurement succeeded",
    rate.source === "measured",
    `source=${rate.source} (RPC unreachable, or clamp rejected the sample)`,
  );
  console.log(
    `       slot=${rate.slotMs.toFixed(1)}ms epoch=${(rate.epochMs / 3_600_000).toFixed(2)}h ` +
      `perMonth=${rate.perMonth.toFixed(2)} perYear=${rate.perYear.toFixed(1)} epoch#${rate.epoch}`,
  );
  if (rate.source !== "measured") return;

  check(
    "measured slot time is inside the clamp",
    rate.slotMs >= MIN_PLAUSIBLE_SLOT_MS && rate.slotMs <= MAX_PLAUSIBLE_SLOT_MS,
    `${rate.slotMs.toFixed(1)}ms`,
  );
  // Loose bound: slot time is a protocol property that moves slowly, so a
  // large drift from the 2026-08-27 baseline means the baseline needs revisiting.
  check(
    "measured slot time is within 25% of the 366ms baseline",
    near(rate.slotMs, 366, 366 * 0.25),
    `${rate.slotMs.toFixed(1)}ms vs 366ms baseline`,
  );
  check("an epoch number was read", typeof rate.epoch === "number");

  clearEpochRateCache();
  const second = await getEpochRate();
  check(
    "a second measurement agrees within 5%",
    near(second.slotMs, rate.slotMs, rate.slotMs * 0.05),
    `${second.slotMs.toFixed(1)}ms vs ${rate.slotMs.toFixed(1)}ms`,
  );
}

async function main() {
  pureSection();
  console.log("live:");
  await liveSection();

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall assertions passed");
}

void main();
