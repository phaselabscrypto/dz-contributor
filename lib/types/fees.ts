export interface EpochFee {
  solanaEpoch: number;
  /** Total fees collected this epoch, in lamports (1e9 = 1 SOL). */
  totalFeeLamports: number;
  /** Total fees collected this epoch, in SOL. Derived from lamports. */
  totalFeeSol: number | null;
  validatorCount: number;
  /**
   * True if this epoch's value is derived from the `previous_fees`
   * aggregate (every pre-934 epoch shares the same averaged value)
   * rather than a measured per-epoch column.
   */
  isEstimated?: boolean;
}

export interface FeeHistory {
  epochs: EpochFee[];
  /** Average per-epoch fees in lamports. */
  averageFeeLamports: number;
  /** Total fees across all epochs in lamports. */
  totalFeeLamports: number;
  /** Average per-epoch fees in SOL (derived from lamports). */
  averageFeeSol: number | null;
  /** Total fees across all epochs in SOL (derived from lamports). */
  totalFeeSol: number | null;
  latestEpoch: number;
  earliestEpoch: number;
  /**
   * SOL/USD spot price from Jupiter v3, or null if the lookup failed.
   * (The 2Z token is not tradeable on Jupiter and 2Z payouts are not
   * active, so no 2Z/SOL price is fetched.)
   */
  solUsdPrice: number | null;
}

export interface ConsolidatedFeeRow {
  solanaEpoch: number;
  totalFeeLamports: number;
  totalPaymentLamports: number;
  status: string;
}
