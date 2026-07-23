#!/usr/bin/env node
/**
 * Scenario-URL codec test: encode/decode round-trips + garbage-in handling
 * (`lib/utils/scenario-url.ts`).
 *
 * Asserts the throw-free contract: `decode(encode(x))` is the identity for
 * every valid `x` (typical scenario, a heavy/maximal-realistic scenario,
 * unicode/delimiter-hostile city codes, and the empty state), and that
 * malformed query values (wrong arity, NaN, negative/zero, duplicate metros,
 * bad percent-encoding) decode to the empty default instead of throwing.
 * Also checks a maximal realistic scenario stays comfortably under the
 * ~2.5 KB worst case noted in the plan.
 *
 * Pure — no snapshot, no network, safe to run anywhere.
 *
 * Usage:
 *   npx tsx scripts/test-scenario-url.ts
 *
 * Exits non-zero on any failed assertion.
 */

import {
  encodeRemovedLinks,
  decodeRemovedLinks,
  encodeAddedLinks,
  decodeAddedLinks,
  encodeDemandOverrides,
  decodeDemandOverrides,
  type AddedLink,
} from "../lib/utils/scenario-url";
import type { DemandOverrides } from "../lib/utils/demand-overrides";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function main() {
  // ── remove: round-trips ────────────────────────────────────────────────
  console.log("removedLinks round-trip:");
  check("empty array", (() => {
    const encoded = encodeRemovedLinks([]);
    return encoded === "" && decodeRemovedLinks(encoded).length === 0;
  })());
  check("typical pubkeys", (() => {
    const pubkeys = [
      "3xk9Wj4pQ2Fh8mZbYc1VdRt7Nq5Ls6Xw2Ea9Kb4Jr8Vp",
      "9fJ2Nm5Lq8Xr3Yt6Wb1Ea4Dh7Zk2Pv5Cs8Rf1Gu3Aa1",
    ];
    const decoded = decodeRemovedLinks(encodeRemovedLinks(pubkeys));
    return JSON.stringify(decoded) === JSON.stringify(pubkeys);
  })());
  check("blank raw decodes to empty", decodeRemovedLinks("").length === 0);
  check(
    "whitespace-only entries dropped",
    JSON.stringify(decodeRemovedLinks("  ,pk1,   ,pk2,")) ===
      JSON.stringify(["pk1", "pk2"])
  );
  check(
    "untrimmed pubkeys trimmed on decode",
    JSON.stringify(decodeRemovedLinks(" pk1 , pk2 ")) ===
      JSON.stringify(["pk1", "pk2"])
  );

  // ── add: round-trips ────────────────────────────────────────────────────
  console.log("\naddedLinks round-trip:");
  check("empty array", (() => {
    const encoded = encodeAddedLinks([]);
    return encoded === "" && decodeAddedLinks(encoded).length === 0;
  })());
  check("typical links", (() => {
    const links: AddedLink[] = [
      { cityA: "fra", cityZ: "nyc", bandwidthGbps: 100, latencyMs: 45 },
      { cityA: "ams", cityZ: "sin", bandwidthGbps: 50, latencyMs: 120.5 },
    ];
    const decoded = decodeAddedLinks(encodeAddedLinks(links));
    return JSON.stringify(decoded) === JSON.stringify(links);
  })());
  check("delimiter-hostile + unicode city codes survive round-trip", (() => {
    const links: AddedLink[] = [
      {
        cityA: "fra,special:code",
        cityZ: "東京-Tōkyō",
        bandwidthGbps: 10,
        latencyMs: 1,
      },
    ];
    const encoded = encodeAddedLinks(links);
    const decoded = decodeAddedLinks(encoded);
    // The delimiter characters must not have split the entry into extras.
    return (
      decoded.length === 1 && JSON.stringify(decoded) === JSON.stringify(links)
    );
  })());
  check(
    "wrong arity dropped (missing field)",
    decodeAddedLinks("fra:nyc:100").length === 0
  );
  check(
    "wrong arity dropped (extra field)",
    decodeAddedLinks("fra:nyc:100:45:extra").length === 0
  );
  check("NaN bandwidth dropped", decodeAddedLinks("fra:nyc:abc:45").length === 0);
  check("NaN latency dropped", decodeAddedLinks("fra:nyc:100:xyz").length === 0);
  check("zero bandwidth dropped", decodeAddedLinks("fra:nyc:0:45").length === 0);
  check(
    "negative bandwidth dropped",
    decodeAddedLinks("fra:nyc:-10:45").length === 0
  );
  check(
    "negative latency dropped",
    decodeAddedLinks("fra:nyc:100:-1").length === 0
  );
  check(
    "malformed percent-encoding dropped, never throws",
    (() => {
      let decoded: AddedLink[] | undefined;
      let threw = false;
      try {
        decoded = decodeAddedLinks("%zz:nyc:100:45");
      } catch {
        threw = true;
      }
      return !threw && decoded !== undefined && decoded.length === 0;
    })()
  );
  check(
    "one malformed entry doesn't drop its well-formed neighbors",
    JSON.stringify(decodeAddedLinks("fra:nyc:100:45,bad-entry,ams:sin:50:120")) ===
      JSON.stringify([
        { cityA: "fra", cityZ: "nyc", bandwidthGbps: 100, latencyMs: 45 },
        { cityA: "ams", cityZ: "sin", bandwidthGbps: 50, latencyMs: 120 },
      ])
  );

  // ── demand: round-trips ─────────────────────────────────────────────────
  console.log("\ndemandOverrides round-trip:");
  check("empty object", (() => {
    const encoded = encodeDemandOverrides({});
    return encoded === "" && Object.keys(decodeDemandOverrides(encoded)).length === 0;
  })());
  check("typical overrides", (() => {
    const overrides: DemandOverrides = { FRA: 522, NYC: 301 };
    const decoded = decodeDemandOverrides(encodeDemandOverrides(overrides));
    return JSON.stringify(decoded) === JSON.stringify(overrides);
  })());
  check(
    "lowercase key uppercased on decode",
    JSON.stringify(decodeDemandOverrides("fra:522")) ===
      JSON.stringify({ FRA: 522 })
  );
  check("wrong arity dropped (no colon)", (() => {
    const decoded = decodeDemandOverrides("FRA");
    return Object.keys(decoded).length === 0;
  })());
  check("wrong arity dropped (extra colon)", (() => {
    const decoded = decodeDemandOverrides("FRA:522:extra");
    return Object.keys(decoded).length === 0;
  })());
  check("NaN count dropped", (() => {
    const decoded = decodeDemandOverrides("FRA:abc");
    return Object.keys(decoded).length === 0;
  })());
  check("negative count dropped", (() => {
    const decoded = decodeDemandOverrides("FRA:-5");
    return Object.keys(decoded).length === 0;
  })());
  check(
    "duplicate metro keeps last occurrence, never throws",
    JSON.stringify(decodeDemandOverrides("FRA:100,FRA:200")) ===
      JSON.stringify({ FRA: 200 })
  );
  check(
    "fractional count rounded",
    JSON.stringify(decodeDemandOverrides("FRA:522.6")) ===
      JSON.stringify({ FRA: 523 })
  );

  // ── size: maximal realistic scenario stays under ~2.5 KB ───────────────
  console.log("\nsize check:");
  const heavyRemove = Array.from(
    { length: 20 },
    (_, i) => `Pubkey${i}${"x".repeat(38)}`
  );
  const heavyAdd: AddedLink[] = Array.from({ length: 15 }, (_, i) => ({
    cityA: `loc-a-${i}`,
    cityZ: `loc-z-${i}`,
    bandwidthGbps: 100,
    latencyMs: 45.5,
  }));
  const heavyDemand: DemandOverrides = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`MET${i}`, 500 + i])
  );

  const encodedRemove = encodeRemovedLinks(heavyRemove);
  const encodedAdd = encodeAddedLinks(heavyAdd);
  const encodedDemand = encodeDemandOverrides(heavyDemand);
  const totalBytes =
    Buffer.byteLength(encodedRemove, "utf8") +
    Buffer.byteLength(encodedAdd, "utf8") +
    Buffer.byteLength(encodedDemand, "utf8");
  const MAX_BYTES = 2.5 * 1024;
  check(
    `heavy scenario (${heavyRemove.length} remove + ${heavyAdd.length} add + ${
      Object.keys(heavyDemand).length
    } demand) = ${totalBytes}B < ${MAX_BYTES}B`,
    totalBytes < MAX_BYTES
  );
  check(
    "heavy scenario still round-trips",
    JSON.stringify(decodeRemovedLinks(encodedRemove)) ===
      JSON.stringify(heavyRemove) &&
      JSON.stringify(decodeAddedLinks(encodedAdd)) === JSON.stringify(heavyAdd) &&
      JSON.stringify(decodeDemandOverrides(encodedDemand)) ===
        JSON.stringify(heavyDemand)
  );

  console.log(
    failures === 0 ? "\nALL PASS" : `\n${failures} assertion(s) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
