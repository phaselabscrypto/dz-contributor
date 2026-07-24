#!/usr/bin/env node
/**
 * Coverage-gap suggestion invariants test: `findCoverageGaps`
 * (`lib/utils/demand.ts`).
 *
 * Asserts the properties that make "Suggested routes" useful:
 *  - origins are diversified (one suggestion per origin metro), so the busiest
 *    city no longer becomes the origin of every top-scored pair;
 *  - intra-metro pairs are never suggested (they earn 0 and 400 on Calculate);
 *  - results stay bounded by `limit`, sorted by score desc, and deterministic;
 *  - a top-up pass fills remaining slots when distinct origins < limit.
 *
 * Pure function over synthetic in-memory fixtures — no snapshot file, no LP
 * solves, safe to run anywhere.
 *
 * Usage:
 *   npx tsx scripts/test-coverage-gaps.ts
 *
 * Exits non-zero on any failed assertion.
 */

import { findCoverageGaps } from "../lib/utils/demand";
import type { CityDemand } from "../lib/types/contributor";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function mkCity(
  locationCode: string,
  metroCode: string | undefined,
  demandScore: number,
  linkCount = 1
): CityDemand {
  return {
    locationCode,
    locationName: locationCode.toUpperCase(),
    country: "XX",
    validatorCount: 1,
    totalSlots: 5,
    linkCount,
    demandScore,
    metroCode,
    metroName: metroCode,
  };
}

const originKey = (c: CityDemand): string => c.metroCode ?? c.locationCode;
const isIntraMetro = (g: { cityA: CityDemand; cityB: CityDemand }): boolean =>
  g.cityA.metroCode !== undefined && g.cityA.metroCode === g.cityB.metroCode;

function main() {
  // ── diversify origins ─────────────────────────────────────────────────
  // One busiest city (a/MA) would otherwise be the origin of every top pair.
  console.log("diversify origins (6 distinct metros, limit 5):");
  const diverse: CityDemand[] = [
    mkCity("a", "MA", 100),
    mkCity("b", "MB", 90),
    mkCity("c", "MC", 80),
    mkCity("d", "MD", 70),
    mkCity("e", "ME", 60),
    mkCity("f", "MF", 50),
  ];
  const g1 = findCoverageGaps(diverse, 5);
  const origins1 = g1.map((g) => originKey(g.cityA));

  check("returns at most `limit`", g1.length <= 5, `len=${g1.length}`);
  check("fills all 5 slots (>=5 distinct origins available)", g1.length === 5);
  check(
    "origins are all distinct",
    new Set(origins1).size === origins1.length,
    origins1.join(",")
  );
  check(
    "busiest city is not the origin of every suggestion",
    origins1.filter((k) => k === "MA").length === 1,
    origins1.join(",")
  );
  check(
    "sorted by score desc",
    g1.every((g, i) => i === 0 || g1[i - 1].score >= g.score),
    g1.map((g) => g.score).join(",")
  );
  check(
    "deterministic across runs",
    JSON.stringify(findCoverageGaps(diverse, 5)) === JSON.stringify(g1)
  );

  // ── orientation: dominant hub surfaces as origin regardless of input order ─
  // Input is deliberately NOT pre-sorted by demandScore (hub last). Without the
  // higher-demand orientation swap the hub would only ever be `cityB` (j > i)
  // and never appear as an origin — dedup would diversify across the spokes
  // only. This case fails if the swap at demand.ts is removed.
  console.log("orientation (unsorted input, hub last):");
  const unsorted: CityDemand[] = [
    mkCity("s1", "MA", 10),
    mkCity("s2", "MB", 20),
    mkCity("hub", "MH", 100),
  ];
  const g5 = findCoverageGaps(unsorted, 5);
  const origins5 = g5.map((g) => originKey(g.cityA));
  check(
    "highest-demand hub is oriented as an origin",
    origins5.includes("MH"),
    origins5.join(",")
  );
  check(
    "top suggestion's origin is the hub (highest-demand endpoint)",
    g5.length > 0 && originKey(g5[0].cityA) === "MH",
    origins5.join(",")
  );

  // ── never suggest an intra-metro pair ─────────────────────────────────
  // g1/g2 share metro MG and are the two highest-demand cities; the fix must
  // drop that pair entirely while still surfacing an MG-origin suggestion via
  // a cross-metro partner.
  console.log("exclude intra-metro pairs (limit 10):");
  const withSameMetro: CityDemand[] = [
    mkCity("g1", "MG", 200),
    mkCity("g2", "MG", 195),
    mkCity("a", "MA", 100),
    mkCity("b", "MB", 90),
    mkCity("c", "MC", 80),
  ];
  const g2 = findCoverageGaps(withSameMetro, 10);
  check("no returned pair is intra-metro", g2.every((g) => !isIntraMetro(g)));
  check(
    "the same-metro (g1,g2) pair is absent",
    !g2.some(
      (g) =>
        (g.cityA.locationCode === "g1" && g.cityB.locationCode === "g2") ||
        (g.cityA.locationCode === "g2" && g.cityB.locationCode === "g1")
    )
  );
  check(
    "MG still appears as an origin (via a cross-metro partner)",
    g2.some((g) => originKey(g.cityA) === "MG")
  );

  // ── top-up when distinct origins < limit ──────────────────────────────
  console.log("top-up beyond distinct origins:");
  // 6 distinct-metro cities => 6 distinct origins but 15 total pairs.
  const g3 = findCoverageGaps(diverse, 10);
  check("tops up to min(totalPairs, limit)", g3.length === 10, `len=${g3.length}`);
  check(
    "top-up set still sorted by score desc",
    g3.every((g, i) => i === 0 || g3[i - 1].score >= g.score)
  );

  // ── metro-less cities: originKey falls back to locationCode ───────────
  console.log("metro-less origins (undefined metroCode):");
  const metroless: CityDemand[] = [
    mkCity("x", undefined, 100),
    mkCity("y", undefined, 90),
    mkCity("z", "MZ", 80),
  ];
  const g4 = findCoverageGaps(metroless, 5);
  check("does not crash and returns pairs", g4.length > 0, `len=${g4.length}`);
  check(
    "metro-less cities get separate origin buckets (not one `undefined` bucket)",
    (() => {
      // x and y are both metro-less; the fallback key is their locationCode, so
      // pass 1 must surface BOTH as origins rather than collapsing them into a
      // single undefined bucket (which would drop one of them).
      const keys = new Set(g4.map((g) => originKey(g.cityA)));
      return keys.has("x") && keys.has("y");
    })()
  );

  // ── degenerate inputs ─────────────────────────────────────────────────
  console.log("degenerate inputs:");
  check("empty input returns []", findCoverageGaps([], 5).length === 0);
  check(
    "single city returns [] (no pairs)",
    findCoverageGaps([mkCity("a", "MA", 100)], 5).length === 0
  );
  check(
    "cities with no slots are ignored",
    findCoverageGaps(
      [
        { ...mkCity("a", "MA", 100), totalSlots: 0 },
        { ...mkCity("b", "MB", 90), totalSlots: 0 },
      ],
      5
    ).length === 0
  );

  console.log(
    failures === 0 ? "\nALL PASS" : `\n${failures} assertion(s) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
