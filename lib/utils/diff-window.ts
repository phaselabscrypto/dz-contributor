import { MIN_DZ_EPOCH } from "@/lib/constants/config";

/** Upper bound accepted for `from` and `to`; the service 404s past the latest epoch. */
export const MAX_DIFF_EPOCH = 100_000;

/** Largest `|to - from|` a diff request may span. */
export const MAX_DIFF_WINDOW = 200;

/** Cache-Control for a successful diff body; the (from, to) pair is immutable. */
export const DIFF_CACHE_CONTROL =
  "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800";

export type DiffWindowValidation =
  | { ok: true; from: number; to: number }
  | { ok: false; error: string };

/** Integers only, matching Rust's `str::parse::<i64>` after a trim. */
function parseEpochParam(raw: string | null): number {
  const trimmed = raw?.trim() ?? "";
  return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

/**
 * Validate the `from` and `to` query params of a diff request. The accepted
 * inputs and the error strings both match the Rust service's
 * `validate_window`, so the two layers are one contract.
 */
export function validateDiffWindow(
  fromRaw: string | null,
  toRaw: string | null,
): DiffWindowValidation {
  const from = parseEpochParam(fromRaw);
  const to = parseEpochParam(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
    return {
      ok: false,
      error: "from and to query params required (different integers)",
    };
  }
  if (
    from < MIN_DZ_EPOCH ||
    to < MIN_DZ_EPOCH ||
    from > MAX_DIFF_EPOCH ||
    to > MAX_DIFF_EPOCH
  ) {
    return {
      ok: false,
      error: `from and to must be in [${MIN_DZ_EPOCH}, ${MAX_DIFF_EPOCH}]`,
    };
  }
  if (Math.abs(to - from) > MAX_DIFF_WINDOW) {
    return {
      ok: false,
      error: `epoch window too wide: |to - from| must be <= ${MAX_DIFF_WINDOW}`,
    };
  }
  return { ok: true, from, to };
}
