/**
 * Per-metro demand overrides: boundary normalization + DZ-parity application.
 *
 * An override sets the validator count for a metro (keyed by UPPERCASED
 * exchange code, e.g. `{"FRA": 522}`) — the same key space the canonical
 * demand table uses for `demand.start`/`demand.end` and that DZ's offchain
 * ingest keys `city_stats` by (`exchange.code.to_uppercase()`).
 *
 * Overrides are applied by REGENERATING the demand table from
 * override-patched city stats — exactly what DZ mainnet does when a city's
 * validator count changes — never by scaling existing rows. Regeneration
 * only changes `receivers` (traffic stays the constant 0.15 per row), so the
 * network-shapley invariant that all rows of one demand type share identical
 * (start, traffic, multicast) holds by construction, and a 0-count metro
 * drops out of the sender set exactly like mainnet.
 *
 * `city_weights` are deliberately NOT recomputed: they derive from the
 * leader-schedule stake proxy, which a validator-count override does not
 * touch.
 */

import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ShapleyInput } from "@/lib/types/shapley";
import { buildCityStats, buildDemands } from "./canonical-input-builder";
import { CANONICAL_SHAPLEY_PARAMS } from "@/lib/constants/config";

/** Per-metro validator-count overrides, keyed by UPPERCASED exchange code. */
export type DemandOverrides = Record<string, number>;

/**
 * Sanity cap on an override value. Far above any realistic metro validator
 * count (largest metros are in the hundreds), and comfortably inside the
 * Rust wire type (`receivers: u32`, services/shapley-rs/src/model.rs:38).
 */
const MAX_OVERRIDE_VALUE = 100_000;

export type NormalizeOverridesResult =
  | { ok: true; overrides: DemandOverrides }
  | { ok: false; error: string };

/**
 * Harden a raw request-body `demandOverrides` value into a canonical
 * override map. Keys are trimmed + uppercased (the Rust demand table is
 * uppercase-keyed and does no case folding); values must be finite,
 * non-negative numbers ≤ 100k and are rounded to integers — `receivers`
 * is a `u32` on the Rust wire, so integer values are load-bearing, not
 * cosmetic.
 *
 * `undefined`/`null`/`{}` normalize to `{ ok: true, overrides: {} }`.
 */
export function normalizeDemandOverrides(
  raw: unknown
): NormalizeOverridesResult {
  if (raw === undefined || raw === null) {
    return { ok: true, overrides: {} };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        "demandOverrides must be an object mapping metro code to validator count, e.g. {\"FRA\": 522}",
    };
  }

  const overrides: DemandOverrides = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = rawKey.trim().toUpperCase();
    if (!key) {
      return { ok: false, error: "demandOverrides contains an empty key" };
    }
    if (key in overrides) {
      return {
        ok: false,
        error: `demandOverrides key "${key}" appears more than once after case normalization`,
      };
    }
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      return {
        ok: false,
        error: `demandOverrides["${rawKey}"] must be a finite number`,
      };
    }
    if (rawValue < 0) {
      return {
        ok: false,
        error: `demandOverrides["${rawKey}"] must be >= 0`,
      };
    }
    if (rawValue > MAX_OVERRIDE_VALUE) {
      return {
        ok: false,
        error: `demandOverrides["${rawKey}"] must be <= ${MAX_OVERRIDE_VALUE}`,
      };
    }
    overrides[key] = Math.round(rawValue);
  }
  return { ok: true, overrides };
}

export type ApplyOverridesResult =
  | { ok: true; input: ShapleyInput }
  | { ok: false; unknownMetros: string[]; knownMetros: string[] };

export type BuildOverriddenInputResult =
  | { ok: true; input: ShapleyInput }
  | { ok: false; error: string };

/**
 * Route-level composition over {@link applyDemandOverrides}: folds the
 * canonical-snapshot requirement, the unknown-metro rejection, and the
 * "no demand rows left" guard into one self-explaining error string (the
 * caller returns it as a 400). Empty overrides are a no-op that returns
 * `baselineInput` unchanged. Shared by `/api/shapley/jobs` and
 * `/api/shapley/simulate` so the two contracts cannot drift.
 */
export function buildOverriddenInput(args: {
  snap: RawSnapshot;
  baselineInput: ShapleyInput;
  overrides: DemandOverrides;
  epoch: number;
  canonical: boolean;
  /** The canonical builder's reason when `canonical` is false, if known. */
  canonicalReason?: string;
}): BuildOverriddenInputResult {
  const { snap, baselineInput, overrides, epoch, canonical, canonicalReason } =
    args;
  if (Object.keys(overrides).length === 0) {
    return { ok: true, input: baselineInput };
  }
  if (!canonical) {
    return {
      ok: false,
      error:
        `demandOverrides require a canonical snapshot; epoch ${epoch} is not` +
        (canonicalReason ? ` (${canonicalReason})` : ""),
    };
  }
  const applied = applyDemandOverrides(snap, baselineInput, overrides);
  if (!applied.ok) {
    return {
      ok: false,
      error: `Unknown metro(s) in demandOverrides: ${applied.unknownMetros.join(
        ", "
      )}. Valid metros: ${applied.knownMetros.join(", ")}`,
    };
  }
  if (applied.input.demands.length === 0) {
    return { ok: false, error: "demandOverrides remove all demand rows" };
  }
  return { ok: true, input: applied.input };
}

/**
 * Apply validator-count overrides by regenerating the demand table from
 * override-patched city stats (DZ-parity — see module doc).
 *
 * The returned input reuses `baselineInput`'s devices/private_links/
 * public_links/city_weights ARRAYS untouched (identical serialization lets
 * the Rust service's `reusable_city_values` reuse per-city results), and
 * swaps in the regenerated demands. `ibrlPriority` is read from the baseline
 * itself so regenerated rows always match the params the baseline was built
 * with.
 *
 * Override keys must exist in the snapshot's city stats (any metro with at
 * least one resolvable user); unknown keys → `ok: false` with the sorted
 * valid-metro list for a self-explaining 400.
 */
export function applyDemandOverrides(
  snap: RawSnapshot,
  baselineInput: ShapleyInput,
  overrides: DemandOverrides
): ApplyOverridesResult {
  const cityStats = buildCityStats(snap);

  const unknownMetros = Object.keys(overrides)
    .filter((metro) => !cityStats.has(metro))
    .sort();
  if (unknownMetros.length > 0) {
    return {
      ok: false,
      unknownMetros,
      knownMetros: [...cityStats.keys()].sort(),
    };
  }

  for (const [metro, count] of Object.entries(overrides)) {
    // Safe: unknown keys were rejected above.
    cityStats.get(metro)!.validators = count;
  }

  const ibrlPriority =
    baselineInput.demands.find((d) => !d.multicast)?.priority ??
    CANONICAL_SHAPLEY_PARAMS.ibrlPriority;

  return {
    ok: true,
    input: {
      ...baselineInput,
      demands: buildDemands(cityStats, ibrlPriority),
    },
  };
}
