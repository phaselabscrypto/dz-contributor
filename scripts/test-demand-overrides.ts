#!/usr/bin/env node
/**
 * Demand-override invariants test: normalize + apply-by-regeneration
 * (`lib/utils/demand-overrides.ts`) against a real snapshot.
 *
 * Asserts the DZ-parity properties that make overrides safe for the solver:
 * only `receivers` changes (traffic stays uniform per demand type), the
 * sender set is preserved (or shrinks/grows exactly like mainnet ingest),
 * shared topology + city_weights are reused untouched, and identical
 * overrides are a byte-identical fixpoint (so the Rust service reuses every
 * per-city result).
 *
 * Pure input construction — no LP solves, safe to run anywhere.
 *
 * Usage:
 *   # Default: tests against /tmp/dz-epoch-149.json
 *   npx tsx scripts/test-demand-overrides.ts
 *
 *   # Custom snapshot:
 *   SNAPSHOT=/path/to/mn-epoch-N-snapshot.json npx tsx scripts/test-demand-overrides.ts
 *
 * Exits non-zero on any failed assertion.
 */

import { readFileSync } from "node:fs";

import { buildCanonicalShapleyInput } from "../lib/utils/canonical-input-builder";
import {
  applyDemandOverrides,
  normalizeDemandOverrides,
} from "../lib/utils/demand-overrides";
import type { RawSnapshot } from "../lib/types/snapshot";
import type { ShapleyInput } from "../lib/types/shapley";

const SNAPSHOT = process.env.SNAPSHOT ?? "/tmp/dz-epoch-149.json";
const MAX_DEMANDS = 2_000; // services/shapley-rs/src/routes.rs:152

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function senders(input: ShapleyInput): Set<string> {
  return new Set(input.demands.filter((d) => !d.multicast).map((d) => d.start));
}

function main() {
  console.log(`snapshot: ${SNAPSHOT}`);
  const raw: RawSnapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

  const built = buildCanonicalShapleyInput(raw);
  if (!built.canonical) {
    console.error(`snapshot is not canonical: ${built.reason}`);
    process.exit(1);
  }
  const baseline = built.input;

  const senderSet = senders(baseline);
  const metro = senderSet.has("FRA") ? "FRA" : [...senderSet].sort()[0];
  const baselineRow = baseline.demands.find(
    (d) => !d.multicast && d.end === metro
  );
  if (!baselineRow) {
    console.error(`no IBRL row ends at sender metro ${metro} — unexpected`);
    process.exit(1);
  }
  const currentCount = baselineRow.receivers;
  const doubled = currentCount * 2;
  console.log(
    `target metro: ${metro} (current=${currentCount}), senders=${senderSet.size}, rows=${baseline.demands.length}`
  );

  // ── normalizeDemandOverrides ──────────────────────────────────────────
  console.log("normalizeDemandOverrides:");
  {
    const r = normalizeDemandOverrides({ " fra ": 522.4 });
    check(
      "trims + uppercases keys, rounds values",
      r.ok && r.overrides.FRA === 522,
      JSON.stringify(r)
    );
  }
  check("undefined → empty overrides", (() => {
    const r = normalizeDemandOverrides(undefined);
    return r.ok && Object.keys(r.overrides).length === 0;
  })());
  check("array rejected", !normalizeDemandOverrides([1, 2]).ok);
  check("negative rejected", !normalizeDemandOverrides({ FRA: -1 }).ok);
  check("NaN rejected", !normalizeDemandOverrides({ FRA: NaN }).ok);
  check("Infinity rejected", !normalizeDemandOverrides({ FRA: Infinity }).ok);
  check("over-cap rejected", !normalizeDemandOverrides({ FRA: 1e9 }).ok);
  check(
    "post-normalization duplicate rejected",
    !normalizeDemandOverrides({ fra: 1, FRA: 2 }).ok
  );

  // ── applyDemandOverrides: doubled count ───────────────────────────────
  console.log(`applyDemandOverrides({${metro}: ${doubled}}):`);
  const appliedDoubled = applyDemandOverrides(raw, baseline, {
    [metro]: doubled,
  });
  if (!appliedDoubled.ok) {
    console.error("apply unexpectedly failed:", appliedDoubled);
    process.exit(1);
  }
  const mod = appliedDoubled.input;

  check(
    `every IBRL row ending at ${metro} has receivers=${doubled}`,
    mod.demands
      .filter((d) => !d.multicast && d.end === metro)
      .every((d) => d.receivers === doubled)
  );
  check(
    `IBRL rows starting at ${metro} keep destination receivers`,
    mod.demands
      .filter((d) => !d.multicast && d.start === metro)
      .every((d) => {
        const base = baseline.demands.find(
          (b) => !b.multicast && b.start === metro && b.end === d.end
        );
        return base !== undefined && d.receivers === base.receivers;
      })
  );
  check(
    "all IBRL traffic is the uniform 0.15 constant",
    mod.demands.filter((d) => !d.multicast).every((d) => d.traffic === 0.15)
  );
  check(
    "per-(start,multicast,priority) traffic uniformity (crate invariant)",
    (() => {
      const seen = new Map<string, number>();
      for (const d of mod.demands) {
        const key = `${d.start}|${d.multicast}|${d.priority}`;
        const prev = seen.get(key);
        if (prev !== undefined && prev !== d.traffic) return false;
        seen.set(key, d.traffic);
      }
      return true;
    })()
  );
  check(
    "sender set unchanged",
    (() => {
      const s = senders(mod);
      return (
        s.size === senderSet.size && [...s].every((c) => senderSet.has(c))
      );
    })()
  );
  check(
    "shared topology arrays reused by reference",
    mod.devices === baseline.devices &&
      mod.private_links === baseline.private_links &&
      mod.public_links === baseline.public_links
  );
  check(
    "city_weights unchanged",
    JSON.stringify(mod.city_weights) === JSON.stringify(baseline.city_weights)
  );
  check(
    `row count ${mod.demands.length} within solver cap ${MAX_DEMANDS}`,
    mod.demands.length <= MAX_DEMANDS
  );

  // ── override to zero: metro leaves the sender set entirely ────────────
  console.log(`applyDemandOverrides({${metro}: 0}):`);
  const appliedZero = applyDemandOverrides(raw, baseline, { [metro]: 0 });
  if (!appliedZero.ok) {
    console.error("apply(0) unexpectedly failed:", appliedZero);
    process.exit(1);
  }
  const zeroed = appliedZero.input;
  check(
    `${metro} absent from all demand starts`,
    zeroed.demands.every((d) => d.start !== metro)
  );
  check(
    `${metro} absent from IBRL ends`,
    zeroed.demands.filter((d) => !d.multicast).every((d) => d.end !== metro)
  );
  const baselineShredEndsAtMetro = baseline.demands.some(
    (d) => d.multicast && d.end === metro
  );
  check(
    `incoming Shred to ${metro} ${baselineShredEndsAtMetro ? "persists" : "absent (no subscribers)"}`,
    zeroed.demands.some((d) => d.multicast && d.end === metro) ===
      baselineShredEndsAtMetro
  );

  // ── fixpoints: {} and {metro: current} regenerate byte-identically ────
  console.log("fixpoints:");
  const appliedEmpty = applyDemandOverrides(raw, baseline, {});
  check(
    "empty overrides regenerate identical demands",
    appliedEmpty.ok &&
      JSON.stringify(appliedEmpty.input.demands) ===
        JSON.stringify(baseline.demands)
  );
  const appliedSame = applyDemandOverrides(raw, baseline, {
    [metro]: currentCount,
  });
  check(
    "override equal to baseline regenerates identical demands",
    appliedSame.ok &&
      JSON.stringify(appliedSame.input.demands) ===
        JSON.stringify(baseline.demands)
  );

  // ── unknown metro rejected with the valid-key list ────────────────────
  console.log("unknown metro:");
  const unknown = applyDemandOverrides(raw, baseline, { ZZZ: 5 });
  check(
    "ZZZ rejected with sorted known metros",
    !unknown.ok &&
      unknown.unknownMetros.length === 1 &&
      unknown.unknownMetros[0] === "ZZZ" &&
      unknown.knownMetros.length > 0 &&
      [...unknown.knownMetros].sort().join() === unknown.knownMetros.join()
  );

  // ── subscriber-only metro becomes a new sender (if one exists) ────────
  const shredOnlyMetro = [
    ...new Set(
      baseline.demands
        .filter((d) => d.multicast && !senderSet.has(d.end))
        .map((d) => d.end)
    ),
  ].sort()[0];
  if (shredOnlyMetro) {
    console.log(`new-sender override (${shredOnlyMetro}):`);
    const promoted = applyDemandOverrides(raw, baseline, {
      [shredOnlyMetro]: 10,
    });
    check(
      `${shredOnlyMetro} becomes a sender with receivers=10 inbound`,
      promoted.ok &&
        senders(promoted.input).has(shredOnlyMetro) &&
        promoted.input.demands
          .filter((d) => !d.multicast && d.end === shredOnlyMetro)
          .every((d) => d.receivers === 10)
    );
  } else {
    console.log("new-sender override: skipped (no subscriber-only metro)");
  }

  console.log(
    failures === 0 ? "\nALL PASS" : `\n${failures} assertion(s) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
