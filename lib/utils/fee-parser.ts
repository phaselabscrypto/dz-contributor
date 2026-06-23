import type { EpochFee, FeeHistory } from "@/lib/types/fees";
import { fetchSolUsdPrice } from "./jupiter-price";

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Parse individual epoch CSV: pubkey,votekey,dz_fee_lamports
 * Per-validator fees are stored as lamport integers.
 */
export function parseFeesCsv(csv: string, solanaEpoch: number): EpochFee | null {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return null;

  let totalLamports = 0;
  let validatorCount = 0;

  // Skip header row (pubkey,votekey,dz_fee_lamports)
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length >= 3) {
      const fee = parseInt(cols[2], 10);
      if (!isNaN(fee) && fee > 0) {
        totalLamports += fee;
        validatorCount++;
      }
    }
  }

  if (validatorCount === 0) return null;

  return {
    solanaEpoch,
    totalFeeLamports: totalLamports,
    totalFeeSol: totalLamports / LAMPORTS_PER_SOL,
    validatorCount,
  };
}

/**
 * Parse consolidated CSV with columns:
 * pubkey,votekey,dz_fee_lamports_934,...,dz_fee_lamports_938,previous_fees,paid_*,previous_paid
 *
 * Per-validator fees are stored in lamports. We pivot to per-epoch totals
 * and keep them in lamports through the API; downstream consumers divide
 * by LAMPORTS_PER_SOL when they need SOL.
 *
 * Older 2Z-suffixed columns are still recognised as a fallback in case
 * the upstream schema flips back.
 */
export function parseConsolidatedCsv(csv: string): EpochFee[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const header = lines[0].split(",");

  // Find fee columns. Upstream currently emits dz_fee_lamports_NNN; the
  // historical schema used dz_fee_2z_NNN. Accept either so a future flip
  // doesn't silently zero us out again.
  const feeColumns: { index: number; epoch: number }[] = [];
  for (let i = 0; i < header.length; i++) {
    const match =
      header[i].match(/^dz_fee_lamports_(\d+)$/) ??
      header[i].match(/^dz_fee_2z_(\d+)$/);
    if (match) {
      feeColumns.push({ index: i, epoch: parseInt(match[1], 10) });
    }
  }

  if (feeColumns.length === 0) return [];

  // Accumulate per-epoch totals in lamports.
  const epochTotals = new Map<
    number,
    { totalLamports: number; validatorCount: number }
  >();
  for (const fc of feeColumns) {
    epochTotals.set(fc.epoch, { totalLamports: 0, validatorCount: 0 });
  }

  // Parse each validator row
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    for (const fc of feeColumns) {
      if (fc.index < cols.length) {
        const fee = parseInt(cols[fc.index], 10);
        if (!isNaN(fee) && fee > 0) {
          const entry = epochTotals.get(fc.epoch)!;
          entry.totalLamports += fee;
          entry.validatorCount++;
        }
      }
    }
  }

  // Sum of fees prior to the epoch range. Upstream uses `previous_fees`;
  // older schema used `previous_fees_2z`.
  const previousFeesIdx = (() => {
    const a = header.indexOf("previous_fees");
    if (a >= 0) return a;
    return header.indexOf("previous_fees_2z");
  })();

  // For epochs before 934, estimate per-epoch from the previous_fees aggregate.
  if (previousFeesIdx >= 0) {
    let totalPreviousLamports = 0;
    let validatorsWithPrevious = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (previousFeesIdx < cols.length) {
        const prev = parseInt(cols[previousFeesIdx], 10);
        if (!isNaN(prev) && prev > 0) {
          totalPreviousLamports += prev;
          validatorsWithPrevious++;
        }
      }
    }

    // Epochs 859–933 = 75 epochs
    const previousEpochCount = 75;
    if (totalPreviousLamports > 0 && previousEpochCount > 0) {
      const avgPerEpoch = totalPreviousLamports / previousEpochCount;
      for (let e = 859; e <= 933; e++) {
        epochTotals.set(e, {
          totalLamports: Math.round(avgPerEpoch),
          validatorCount: validatorsWithPrevious,
        });
      }
    }
  }

  // Convert to array. Pre-934 epochs are derived from the `previous_fees`
  // aggregate (every pre-934 epoch shares the same averaged value), so
  // we tag them with `isEstimated` so the UI can flag the distinction.
  const epochs: EpochFee[] = [];
  for (const [epoch, data] of epochTotals) {
    epochs.push({
      solanaEpoch: epoch,
      totalFeeLamports: data.totalLamports,
      totalFeeSol: data.totalLamports / LAMPORTS_PER_SOL,
      validatorCount: data.validatorCount,
      isEstimated: epoch < 934,
    });
  }

  return epochs;
}

export async function computeFeeHistory(epochs: EpochFee[]): Promise<FeeHistory> {
  if (epochs.length === 0) {
    return {
      epochs: [],
      averageFeeLamports: 0,
      totalFeeLamports: 0,
      averageFeeSol: null,
      totalFeeSol: null,
      latestEpoch: 0,
      earliestEpoch: 0,
      solUsdPrice: null,
    };
  }

  const sorted = [...epochs].sort((a, b) => a.solanaEpoch - b.solanaEpoch);
  const totalLamports = sorted.reduce(
    (sum, e) => sum + e.totalFeeLamports,
    0,
  );
  const averageLamports = totalLamports / sorted.length;
  const totalFeeSol = totalLamports / LAMPORTS_PER_SOL;
  const averageFeeSol = totalFeeSol / sorted.length;

  // Live SOL/USD spot from Jupiter v3 (lite-api free tier). Failure
  // is non-fatal — the UI shows "—" when this is null.
  const solUsdPrice = await fetchSolUsdPrice().catch(() => null);

  return {
    epochs: sorted,
    averageFeeLamports: averageLamports,
    totalFeeLamports: totalLamports,
    averageFeeSol,
    totalFeeSol,
    latestEpoch: sorted[sorted.length - 1].solanaEpoch,
    earliestEpoch: sorted[0].solanaEpoch,
    solUsdPrice,
  };
}
