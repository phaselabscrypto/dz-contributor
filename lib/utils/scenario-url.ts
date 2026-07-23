/**
 * Scenario-URL codec: encode/decode the simulator's editable state
 * (removed links, added links, demand overrides) into readable query-string
 * values, plus `nuqs` parsers built on top.
 *
 * Mirrors the `link-edits.ts` / `demand-overrides.ts` conventions: pure,
 * throw-free, two-stage (encode is a trusted-input formatter; decode is a
 * hostile-input parser that never throws — malformed pieces are dropped, not
 * rejected). This is a URL-syntax layer only: decode is deliberately lenient
 * (wrong arity, non-finite/out-of-range scalars, duplicate keys are dropped
 * silently) because the server re-validates everything via the 415787b
 * validator chain (`link-edits.ts`, `demand-overrides.ts`) and returns
 * self-explaining 400s. `decode(encode(x))` is the identity for every valid
 * `x`; `decode(garbage)` is the empty default, never an exception.
 *
 * Formats:
 *   - remove: comma-joined base58 pubkeys — `remove=3xk9...pQ2,9fJ2...aa1`
 *   - add:    comma-joined `cityA:cityZ:bandwidthGbps:latencyMs` entries —
 *             `add=fra:nyc:100:45,ams:sin:50:120`. City codes are
 *             `encodeURIComponent`d individually so a `:` or `,` inside a
 *             location code can never be mistaken for a delimiter.
 *   - demand: comma-joined `METRO:count` pairs — `demand=FRA:522,NYC:301`
 *             (uppercase metro keys, integer counts — matches the
 *             `DemandOverrides` contract in `demand-overrides.ts`).
 */

import { createParser } from "nuqs";
import type { DemandOverrides } from "./demand-overrides";

/**
 * A single added link exactly as `SimulateTab` holds it in `addedLinks`
 * (components/simulator/simulate-tab.tsx) — both numeric fields are always
 * present (UI presets/inputs default them), unlike the optional
 * `bandwidthGbps`/`latencyMs` on the server's `NormalizedAddLink`.
 */
export interface AddedLink {
  cityA: string;
  cityZ: string;
  bandwidthGbps: number;
  latencyMs: number;
}

// ── remove: link pubkeys ────────────────────────────────────────────────────

/** Comma-join removed-link pubkeys. Empty array encodes to `""`. */
export function encodeRemovedLinks(pubkeys: readonly string[]): string {
  return pubkeys.map((p) => p.trim()).filter(Boolean).join(",");
}

/**
 * Split on `,`, trim, drop empties. Never throws — an empty/blank `raw`
 * decodes to `[]`.
 */
export function decodeRemovedLinks(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── add: added links ────────────────────────────────────────────────────────

/** Comma-join added links as `cityA:cityZ:bandwidthGbps:latencyMs`. */
export function encodeAddedLinks(links: readonly AddedLink[]): string {
  return links
    .map(
      (l) =>
        `${encodeURIComponent(l.cityA)}:${encodeURIComponent(l.cityZ)}:${l.bandwidthGbps}:${l.latencyMs}`
    )
    .join(",");
}

/**
 * Split on `,` then `:`, `decodeURIComponent` the city fields. Drops (never
 * throws on) any entry that is malformed: wrong field count, unparseable
 * percent-encoding, empty city code after decoding, or a non-finite/≤ 0
 * bandwidth / non-finite/negative latency — lenient by design, the server
 * re-validates via `link-edits.ts`.
 */
export function decodeAddedLinks(raw: string): AddedLink[] {
  if (!raw) return [];
  const links: AddedLink[] = [];
  for (const entry of raw.split(",")) {
    if (!entry) continue;
    const parts = entry.split(":");
    if (parts.length !== 4) continue;
    const [rawCityA, rawCityZ, rawBandwidth, rawLatency] = parts;

    let cityA: string;
    let cityZ: string;
    try {
      cityA = decodeURIComponent(rawCityA);
      cityZ = decodeURIComponent(rawCityZ);
    } catch {
      continue; // malformed percent-encoding
    }
    if (!cityA || !cityZ) continue;

    const bandwidthGbps = Number(rawBandwidth);
    if (!Number.isFinite(bandwidthGbps) || bandwidthGbps <= 0) continue;

    const latencyMs = Number(rawLatency);
    if (!Number.isFinite(latencyMs) || latencyMs < 0) continue;

    links.push({ cityA, cityZ, bandwidthGbps, latencyMs });
  }
  return links;
}

// ── demand: per-metro validator-count overrides ─────────────────────────────

/** Comma-join overrides as `METRO:count`, uppercasing keys defensively. */
export function encodeDemandOverrides(overrides: DemandOverrides): string {
  return Object.entries(overrides)
    .map(([metro, count]) => `${metro.trim().toUpperCase()}:${Math.round(count)}`)
    .join(",");
}

/**
 * Split on `,` then `:`. Drops (never throws on) any pair with the wrong
 * field count, an empty metro code, or a non-finite/negative count; a
 * duplicate metro key keeps its last occurrence (plain object assignment —
 * no error, unlike the strict server-side validator).
 */
export function decodeDemandOverrides(raw: string): DemandOverrides {
  if (!raw) return {};
  const overrides: DemandOverrides = {};
  for (const entry of raw.split(",")) {
    if (!entry) continue;
    const parts = entry.split(":");
    if (parts.length !== 2) continue;
    const [rawMetro, rawCount] = parts;
    const metro = rawMetro.trim().toUpperCase();
    if (!metro) continue;

    const count = Number(rawCount);
    if (!Number.isFinite(count) || count < 0) continue;

    overrides[metro] = Math.round(count);
  }
  return overrides;
}

// ── nuqs parsers ─────────────────────────────────────────────────────────────

/** `nuqs` parser for the `remove` param; missing/garbage → `[]`. */
export const parseAsRemovedLinks = createParser<string[]>({
  parse: decodeRemovedLinks,
  serialize: encodeRemovedLinks,
}).withDefault([]);

/** `nuqs` parser for the `add` param; missing/garbage → `[]`. */
export const parseAsAddedLinks = createParser<AddedLink[]>({
  parse: decodeAddedLinks,
  serialize: encodeAddedLinks,
}).withDefault([]);

/** `nuqs` parser for the `demand` param; missing/garbage → `{}`. */
export const parseAsDemandOverrides = createParser<DemandOverrides>({
  parse: decodeDemandOverrides,
  serialize: encodeDemandOverrides,
}).withDefault({});
