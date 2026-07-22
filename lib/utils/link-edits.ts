/**
 * Link-edit input validation: boundary normalization + snapshot-aware checks.
 *
 * Mirrors the demand-override contract (`lib/utils/demand-overrides.ts`) for
 * the simulator's link editor. Bad link input used to be accepted and then
 * silently dropped by `modifyShapleyInput` (an unknown location, a stale
 * removal pubkey, a negative bandwidth, an unrecognized contributor, or a
 * same-metro link all `continue` past without error), returning an unchanged
 * forecast. These validators make each of those fail loudly with a self-
 * explaining 400 instead.
 *
 * Two stages, exactly like the demand side:
 *   1. `normalizeLinkEdits`             — pure scalar/shape checks, no snapshot.
 *   2. `validateLinkEditsAgainstSnapshot` — location/contributor/pubkey checks
 *                                           against the same maps the modifier
 *                                           resolves against, so validation can
 *                                           never diverge from what the solver
 *                                           accepts.
 *
 * Both are pure (no throws) and return discriminated-union `Result`s so the
 * routes can turn `ok: false` into `NextResponse.json({ error }, 400)` and the
 * two routes cannot drift.
 */

import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ParsedSnapshot } from "@/lib/types/contributor";
import {
  buildCityNameToMetro,
  buildLocationCodeToMetro,
} from "./shapley-input-builder";
import { NEW_CONTRIBUTOR_SIM_CODE } from "@/lib/constants/config";

/**
 * Sanity caps on add-link numeric fields. `MAX_BANDWIDTH_GBPS` is 10× the
 * largest UI preset (100 Gbps); `MAX_LATENCY_MS` is far above any real fibre
 * RTT. Both reject absurd values without baking the UI presets into the API.
 */
const MAX_BANDWIDTH_GBPS = 1_000;
const MAX_LATENCY_MS = 10_000;

/** A single add-link edit after scalar/shape normalization. */
export interface NormalizedAddLink {
  cityA: string; // locationCode, trimmed, non-empty
  cityZ: string; // locationCode, trimmed, non-empty
  /** If present: finite, > 0, <= MAX_BANDWIDTH_GBPS. Absent → modifier default. */
  bandwidthGbps?: number;
  /** If present: finite, >= 0, <= MAX_LATENCY_MS. Absent → modifier default. */
  latencyMs?: number;
}

export type NormalizeLinkEditsResult =
  | { ok: true; addLinks: NormalizedAddLink[]; removeLinks: string[] }
  | { ok: false; error: string };

export type ValidateLinkEditsResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Harden the raw request-body `addLinks` / `removeLinks` into normalized
 * shapes. Pure — no snapshot needed. `undefined`/`null` for either field
 * normalizes to an empty array; a present-but-non-array value is rejected
 * (rather than silently coerced to `[]`, which is how the silent no-op used
 * to start).
 *
 * Bandwidth/latency are only validated when present so an omitted value still
 * falls back to the modifier's `?? 10` default (preserving current behavior
 * for un-specified fields). `bandwidthGbps` is left in Gbps and passed through
 * unchanged — the modifier assigns it directly (the wire-type "Mbps" comment
 * is a pre-existing inconsistency this must not "fix").
 */
export function normalizeLinkEdits(
  rawAddLinks: unknown,
  rawRemoveLinks: unknown
): NormalizeLinkEditsResult {
  // ── removeLinks: array of non-empty pubkey strings ──────────────────────
  const removeLinks: string[] = [];
  if (rawRemoveLinks !== undefined && rawRemoveLinks !== null) {
    if (!Array.isArray(rawRemoveLinks)) {
      return { ok: false, error: "removeLinks must be an array of link pubkeys" };
    }
    for (const [i, rawPubkey] of rawRemoveLinks.entries()) {
      if (typeof rawPubkey !== "string" || !rawPubkey.trim()) {
        return {
          ok: false,
          error: `removeLinks[${i}] must be a non-empty string (link pubkey)`,
        };
      }
      removeLinks.push(rawPubkey.trim());
    }
  }

  // ── addLinks: array of { cityA, cityZ, bandwidthGbps?, latencyMs? } ──────
  const addLinks: NormalizedAddLink[] = [];
  if (rawAddLinks !== undefined && rawAddLinks !== null) {
    if (!Array.isArray(rawAddLinks)) {
      return { ok: false, error: "addLinks must be an array of link edits" };
    }
    for (const [i, rawLink] of rawAddLinks.entries()) {
      if (
        typeof rawLink !== "object" ||
        rawLink === null ||
        Array.isArray(rawLink)
      ) {
        return { ok: false, error: `addLinks[${i}] must be an object` };
      }
      const { cityA, cityZ, bandwidthGbps, latencyMs } = rawLink as Record<
        string,
        unknown
      >;

      if (typeof cityA !== "string" || !cityA.trim()) {
        return {
          ok: false,
          error: `addLinks[${i}].cityA must be a non-empty location code`,
        };
      }
      if (typeof cityZ !== "string" || !cityZ.trim()) {
        return {
          ok: false,
          error: `addLinks[${i}].cityZ must be a non-empty location code`,
        };
      }
      const a = cityA.trim();
      const z = cityZ.trim();
      if (a === z) {
        return {
          ok: false,
          error: `addLinks[${i}] endpoints cityA and cityZ must differ (both "${a}")`,
        };
      }

      const normalized: NormalizedAddLink = { cityA: a, cityZ: z };

      if (bandwidthGbps !== undefined) {
        if (typeof bandwidthGbps !== "number" || !Number.isFinite(bandwidthGbps)) {
          return {
            ok: false,
            error: `addLinks[${i}].bandwidthGbps must be a finite number`,
          };
        }
        if (bandwidthGbps <= 0) {
          return {
            ok: false,
            error: `addLinks[${i}].bandwidthGbps must be > 0`,
          };
        }
        if (bandwidthGbps > MAX_BANDWIDTH_GBPS) {
          return {
            ok: false,
            error: `addLinks[${i}].bandwidthGbps must be <= ${MAX_BANDWIDTH_GBPS}`,
          };
        }
        normalized.bandwidthGbps = bandwidthGbps;
      }

      if (latencyMs !== undefined) {
        if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
          return {
            ok: false,
            error: `addLinks[${i}].latencyMs must be a finite number`,
          };
        }
        if (latencyMs < 0) {
          return { ok: false, error: `addLinks[${i}].latencyMs must be >= 0` };
        }
        if (latencyMs > MAX_LATENCY_MS) {
          return {
            ok: false,
            error: `addLinks[${i}].latencyMs must be <= ${MAX_LATENCY_MS}`,
          };
        }
        normalized.latencyMs = latencyMs;
      }

      addLinks.push(normalized);
    }
  }

  return { ok: true, addLinks, removeLinks };
}

/**
 * Snapshot-aware validation of already-normalized link edits. Rejects, with a
 * self-explaining 400 message:
 *   - an unrecognized `contributorCode` (the `new_contributor_sim` sentinel is
 *     accepted, but only with an empty `removeLinks` — a new contributor has
 *     no existing links to remove);
 *   - an add-link endpoint that is not a known location in this snapshot;
 *   - an add-link whose two endpoints resolve to the same metro (a solver
 *     no-op — see the modifier's `metro1 === metro2` skip);
 *   - a removal pubkey that does not belong to the contributor's links.
 *
 * Resolves locations via the SAME `buildLocationCodeToMetro` map the modifier
 * uses (`shapley-input-modifier.ts`), so an accepted edit is guaranteed to be
 * one the modifier will actually apply.
 */
export function validateLinkEditsAgainstSnapshot(args: {
  raw: RawSnapshot;
  parsed: ParsedSnapshot;
  contributorCode: string;
  addLinks: NormalizedAddLink[];
  removeLinks: string[];
}): ValidateLinkEditsResult {
  const { raw, parsed, contributorCode, addLinks, removeLinks } = args;

  const locToMetro = buildLocationCodeToMetro(raw, buildCityNameToMetro(raw));

  // ── Contributor ─────────────────────────────────────────────────────────
  const contributor =
    contributorCode === NEW_CONTRIBUTOR_SIM_CODE
      ? null
      : parsed.contributors.find((c) => c.code === contributorCode);

  if (contributorCode === NEW_CONTRIBUTOR_SIM_CODE) {
    if (removeLinks.length > 0) {
      return {
        ok: false,
        error: "Cannot remove links for a new contributor (it has none yet)",
      };
    }
  } else if (!contributor) {
    const valid = parsed.contributors
      .map((c) => c.code)
      .sort()
      .join(", ");
    return {
      ok: false,
      error: `Unknown contributor "${contributorCode}". Valid contributors: ${valid}`,
    };
  }

  // ── Add-link endpoints: known location + not same-metro ─────────────────
  const unknownLocations = [
    ...new Set(
      addLinks.flatMap((l) =>
        [l.cityA, l.cityZ].filter((code) => !locToMetro.has(code))
      )
    ),
  ].sort();
  if (unknownLocations.length > 0) {
    return {
      ok: false,
      error: `Unknown location(s) in add link: ${unknownLocations.join(
        ", "
      )}. Endpoints must be locations present in this epoch's snapshot.`,
    };
  }
  for (const l of addLinks) {
    const metroA = locToMetro.get(l.cityA);
    const metroZ = locToMetro.get(l.cityZ);
    if (metroA === metroZ) {
      return {
        ok: false,
        error: `Add-link endpoints ${l.cityA} and ${l.cityZ} resolve to the same metro (${metroA}); pick endpoints in different metros`,
      };
    }
  }

  // ── Remove-link pubkeys must belong to the contributor ──────────────────
  // (The new-contributor sentinel already forced removeLinks empty above, so
  // `contributor` is guaranteed non-null whenever this loop has work.)
  if (contributor) {
    const stalePubkeys = removeLinks.filter(
      (pubkey) => !contributor.links.some((l) => l.pubkey === pubkey)
    );
    if (stalePubkeys.length > 0) {
      return {
        ok: false,
        error: `Link(s) not found for contributor "${contributorCode}": ${stalePubkeys.join(
          ", "
        )}`,
      };
    }
  }

  return { ok: true };
}
