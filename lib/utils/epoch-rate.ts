/**
 * Measured Solana epoch rate: how many epochs fall in a month and a year.
 *
 * Every monthly and yearly SOL projection in the app multiplies a per-epoch
 * figure by these numbers, so they are load-bearing on numbers a grant
 * reviewer audits.
 *
 * They used to be the hardcoded `EPOCHS_PER_MONTH = 13` and
 * `EPOCHS_PER_YEAR = 166` in `lib/constants/config.ts`, derived from a 2.2-day
 * epoch. Mainnet slot time has since dropped to about 366 ms, which makes an
 * epoch 43.9 hours and the real figures 16.4 and 200. The old constants
 * understated monthly payouts by 20.8% and yearly by 16.9%. Their own comment
 * named the trigger to update them, and nothing fired. Measuring removes the
 * class of bug rather than the instance.
 *
 * The cost is that a displayed projection now depends on an RPC read. Three
 * things bound that: a six-hour cache, a sanity clamp on the measured slot
 * time, and a fallback that is the current correct measurement rather than the
 * stale one, so an RPC outage degrades to a right answer.
 */

import { getBlockTime, getEpochInfo, getSlot } from "@/lib/onchain/client";
import { reportError } from "@/lib/observability";

/** Slots per epoch on mainnet. Used only for the fallback and as the
 *  preferred sampling window; the live value comes from `getEpochInfo`. */
const MAINNET_SLOTS_PER_EPOCH = 432_000;

/**
 * Preferred sampling window, in slots. `getBlockTime` reports whole seconds,
 * so a wide window is what buys precision: 432,000 slots spans about 158,000
 * seconds, holding the one-second quantisation error near 0.0006%.
 */
const WIDE_WINDOW_SLOTS = 432_000;

/**
 * Fallback window for a node that has pruned past the wide one. Still spans
 * about 18,000 seconds, so quantisation error stays near 0.005%.
 */
const NARROW_WINDOW_SLOTS = 50_000;

/**
 * Accepted range for a measured slot time. Mainnet has run between roughly
 * 400 ms and 800 ms historically and is near 366 ms now. Anything outside this
 * is a pruned node, a clock skew, or a bad block time, and must not become a
 * multiplier on a displayed SOL figure.
 */
const MIN_PLAUSIBLE_SLOT_MS = 200;
const MAX_PLAUSIBLE_SLOT_MS = 1_000;

const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

const MS_PER_MONTH = 30 * 86_400_000;
const MS_PER_YEAR = 365 * 86_400_000;

export interface EpochRate {
  /** Measured mean slot time in milliseconds. */
  slotMs: number;
  /** Epoch duration in milliseconds. */
  epochMs: number;
  perMonth: number;
  perYear: number;
  /** Epoch the measurement was taken in. Null on the fallback. */
  epoch: number | null;
  source: "measured" | "fallback";
  measuredAt: string;
}

function rateFromSlotMs(
  slotMs: number,
  slotsPerEpoch: number,
  epoch: number | null,
  source: EpochRate["source"],
): EpochRate {
  const epochMs = slotsPerEpoch * slotMs;
  return {
    slotMs,
    epochMs,
    perMonth: MS_PER_MONTH / epochMs,
    perYear: MS_PER_YEAR / epochMs,
    epoch,
    source,
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Measured 2026-08-27 over a full 432,000-slot window on mainnet: 366 ms
 * slots, so a 43.9-hour epoch, 16.4 epochs per month and 200 per year.
 *
 * Served whenever the RPC reads fail. Correct at time of writing, unlike the
 * constants this module replaces, so a degraded read is still a right answer.
 */
export const FALLBACK_EPOCH_RATE: EpochRate = rateFromSlotMs(
  366,
  MAINNET_SLOTS_PER_EPOCH,
  null,
  "fallback",
);

let cached: { rate: EpochRate; ts: number } | null = null;
let inFlight: Promise<EpochRate> | null = null;

/**
 * Mean slot time in ms across a slot window, or null when either block time is
 * unavailable. Tries the wide window first, then the narrow one, because a
 * node that prunes history will not answer for a slot an epoch back.
 */
async function measureSlotMs(anchorSlot: number): Promise<number | null> {
  for (const window of [WIDE_WINDOW_SLOTS, NARROW_WINDOW_SLOTS]) {
    const farSlot = anchorSlot - window;
    if (farSlot < 0) continue;

    const [near, far] = await Promise.all([
      getBlockTime(anchorSlot),
      getBlockTime(farSlot),
    ]);
    if (near === null || far === null || near <= far) continue;

    return ((near - far) * 1_000) / window;
  }
  return null;
}

/**
 * Current epoch rate, measured from the chain and cached for six hours.
 *
 * Never throws and never rejects. Any failure reports the error and returns
 * `FALLBACK_EPOCH_RATE`, because the caller has a number to render either way.
 *
 * @returns the measured rate, or `FALLBACK_EPOCH_RATE` with
 *   `source: "fallback"` when the chain could not be read or the measurement
 *   failed the plausibility clamp.
 */
export async function getEpochRate(): Promise<EpochRate> {
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.rate;
  // The measurement is three RPC calls, so concurrent cold callers share one.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const [epochInfo, anchorSlot] = await Promise.all([
        getEpochInfo(),
        getSlot(),
      ]);
      const slotMs = await measureSlotMs(anchorSlot);

      if (slotMs === null) {
        reportError(new Error("no usable block times"), {
          source: "lib/utils/epoch-rate#getEpochRate",
          extras: { anchorSlot },
        });
        return FALLBACK_EPOCH_RATE;
      }
      if (slotMs < MIN_PLAUSIBLE_SLOT_MS || slotMs > MAX_PLAUSIBLE_SLOT_MS) {
        reportError(new Error(`implausible slot time: ${slotMs.toFixed(1)}ms`), {
          source: "lib/utils/epoch-rate#getEpochRate",
          extras: { slotMs, anchorSlot },
        });
        return FALLBACK_EPOCH_RATE;
      }

      const slotsPerEpoch =
        epochInfo.slotsInEpoch > 0
          ? epochInfo.slotsInEpoch
          : MAINNET_SLOTS_PER_EPOCH;
      const rate = rateFromSlotMs(
        slotMs,
        slotsPerEpoch,
        epochInfo.epoch,
        "measured",
      );
      cached = { rate, ts: Date.now() };
      return rate;
    } catch (err) {
      reportError(err, { source: "lib/utils/epoch-rate#getEpochRate" });
      return FALLBACK_EPOCH_RATE;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Reset the cached measurement. For tests and forced refresh. */
export function clearEpochRateCache() {
  cached = null;
  inFlight = null;
}

/**
 * Exposed for tests so the clamp and the derivation can be exercised without
 * network access.
 */
export const __testing = {
  rateFromSlotMs,
  MIN_PLAUSIBLE_SLOT_MS,
  MAX_PLAUSIBLE_SLOT_MS,
  WIDE_WINDOW_SLOTS,
  NARROW_WINDOW_SLOTS,
};
