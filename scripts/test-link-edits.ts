#!/usr/bin/env node
/**
 * Link-edit validation test: normalize + snapshot-aware checks
 * (`lib/utils/link-edits.ts`) against a real snapshot.
 *
 * Asserts the fail-loud contract that mirrors the demand side: malformed /
 * out-of-range scalars are rejected by `normalizeLinkEdits`; unknown
 * locations, same-metro pairs, unrecognized contributors, and stale removal
 * pubkeys are rejected by `validateLinkEditsAgainstSnapshot`; and the two
 * legitimate paths (a real contributor with a real link, the
 * `new_contributor_sim` sentinel with add-only edits) are accepted.
 *
 * Pure input construction — no LP solves, safe to run anywhere.
 *
 * Usage:
 *   # Default: tests against /tmp/dz-epoch-149.json
 *   npx tsx scripts/test-link-edits.ts
 *
 *   # Custom snapshot (prefer a RECENT epoch):
 *   SNAPSHOT=/path/to/mn-epoch-N-snapshot.json npx tsx scripts/test-link-edits.ts
 *
 * Exits non-zero on any failed assertion.
 */

import { readFileSync } from "node:fs";

import { parseSnapshot } from "../lib/utils/snapshot-parser";
import {
  buildCityNameToMetro,
  buildLocationCodeToMetro,
} from "../lib/utils/shapley-input-builder";
import {
  normalizeLinkEdits,
  validateLinkEditsAgainstSnapshot,
} from "../lib/utils/link-edits";
import { NEW_CONTRIBUTOR_SIM_CODE } from "../lib/constants/config";
import type { RawSnapshot } from "../lib/types/snapshot";

const SNAPSHOT = process.env.SNAPSHOT ?? "/tmp/dz-epoch-149.json";

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
  // ── normalizeLinkEdits (pure — no snapshot needed) ────────────────────
  console.log("normalizeLinkEdits:");
  check("undefined → empty arrays", (() => {
    const r = normalizeLinkEdits(undefined, undefined);
    return r.ok && r.addLinks.length === 0 && r.removeLinks.length === 0;
  })());
  check("non-array addLinks rejected", !normalizeLinkEdits("nope", []).ok);
  check("non-array removeLinks rejected", !normalizeLinkEdits([], "nope").ok);
  check(
    "non-string removeLink rejected",
    !normalizeLinkEdits([], [123]).ok
  );
  check(
    "blank removeLink rejected",
    !normalizeLinkEdits([], ["   "]).ok
  );
  check(
    "missing cityA rejected",
    !normalizeLinkEdits([{ cityZ: "B" }], []).ok
  );
  check(
    "blank cityA rejected",
    !normalizeLinkEdits([{ cityA: "  ", cityZ: "B" }], []).ok
  );
  check(
    "identical endpoints rejected",
    !normalizeLinkEdits([{ cityA: "A", cityZ: "A" }], []).ok
  );
  check(
    "negative bandwidth rejected",
    !normalizeLinkEdits([{ cityA: "A", cityZ: "B", bandwidthGbps: -1 }], []).ok
  );
  check(
    "zero bandwidth rejected",
    !normalizeLinkEdits([{ cityA: "A", cityZ: "B", bandwidthGbps: 0 }], []).ok
  );
  check(
    "NaN bandwidth rejected",
    !normalizeLinkEdits([{ cityA: "A", cityZ: "B", bandwidthGbps: NaN }], []).ok
  );
  check(
    "Infinity bandwidth rejected",
    !normalizeLinkEdits(
      [{ cityA: "A", cityZ: "B", bandwidthGbps: Infinity }],
      []
    ).ok
  );
  check(
    "over-cap bandwidth rejected",
    !normalizeLinkEdits([{ cityA: "A", cityZ: "B", bandwidthGbps: 1e6 }], []).ok
  );
  check(
    "negative latency rejected",
    !normalizeLinkEdits([{ cityA: "A", cityZ: "B", latencyMs: -1 }], []).ok
  );
  check("well-formed edit accepted, values preserved", (() => {
    const r = normalizeLinkEdits(
      [{ cityA: " A ", cityZ: "B", bandwidthGbps: 10 }],
      ["pk1"]
    );
    return (
      r.ok &&
      r.addLinks.length === 1 &&
      r.addLinks[0].cityA === "A" && // trimmed
      r.addLinks[0].cityZ === "B" &&
      r.addLinks[0].bandwidthGbps === 10 &&
      r.addLinks[0].latencyMs === undefined && // absent stays undefined
      r.removeLinks.length === 1 &&
      r.removeLinks[0] === "pk1"
    );
  })());

  // ── validateLinkEditsAgainstSnapshot (needs a real snapshot) ──────────
  console.log(`\nsnapshot: ${SNAPSHOT}`);
  const raw: RawSnapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const parsed = parseSnapshot(raw);

  const locToMetro = buildLocationCodeToMetro(raw, buildCityNameToMetro(raw));
  if (locToMetro.size === 0) {
    console.error("snapshot has no resolvable locations — cannot test");
    process.exit(1);
  }

  // Group locations by metro to build known cross-metro and same-metro pairs.
  const metroToLocs = new Map<string, string[]>();
  for (const [loc, metro] of locToMetro) {
    const arr = metroToLocs.get(metro) ?? [];
    arr.push(loc);
    metroToLocs.set(metro, arr);
  }
  const metros = [...metroToLocs.keys()].sort();
  const crossMetroPair =
    metros.length >= 2
      ? ([metroToLocs.get(metros[0])![0], metroToLocs.get(metros[1])![0]] as const)
      : null;
  const sameMetroEntry = [...metroToLocs.values()].find((v) => v.length >= 2);
  const sameMetroPair = sameMetroEntry
    ? ([sameMetroEntry[0], sameMetroEntry[1]] as const)
    : null;

  const contribWithLinks = parsed.contributors.find(
    (c) => c.linkCount > 0 && c.links.length > 0
  );

  console.log("validateLinkEditsAgainstSnapshot:");

  if (!crossMetroPair) {
    console.error("snapshot has < 2 metros — cannot run add-link tests");
    process.exit(1);
  }
  const [locX, locY] = crossMetroPair;

  // Unknown location rejected, naming the bad code.
  {
    const r = validateLinkEditsAgainstSnapshot({
      raw,
      parsed,
      contributorCode: contribWithLinks?.code ?? NEW_CONTRIBUTOR_SIM_CODE,
      addLinks: [{ cityA: "ZZZ-NOT-A-LOCATION", cityZ: locY }],
      removeLinks: [],
    });
    check(
      "unknown location rejected, names bad code",
      !r.ok && r.error.includes("ZZZ-NOT-A-LOCATION")
    );
  }

  // Known cross-metro pair accepted (new-contributor path — no contributor needed).
  check(
    "known cross-metro add-link accepted",
    validateLinkEditsAgainstSnapshot({
      raw,
      parsed,
      contributorCode: NEW_CONTRIBUTOR_SIM_CODE,
      addLinks: [{ cityA: locX, cityZ: locY }],
      removeLinks: [],
    }).ok
  );

  // Same-metro pair rejected.
  if (sameMetroPair) {
    const [sa, sz] = sameMetroPair;
    check(
      "same-metro add-link rejected",
      !validateLinkEditsAgainstSnapshot({
        raw,
        parsed,
        contributorCode: NEW_CONTRIBUTOR_SIM_CODE,
        addLinks: [{ cityA: sa, cityZ: sz }],
        removeLinks: [],
      }).ok
    );
  } else {
    console.log("  skip same-metro add-link (no metro has 2+ locations)");
  }

  // Unknown contributor rejected, listing valid codes.
  {
    const r = validateLinkEditsAgainstSnapshot({
      raw,
      parsed,
      contributorCode: "does-not-exist-xyz",
      addLinks: [{ cityA: locX, cityZ: locY }],
      removeLinks: [],
    });
    check(
      "unknown contributor rejected, lists valid",
      !r.ok &&
        r.error.includes("does-not-exist-xyz") &&
        r.error.includes("Valid contributors")
    );
  }

  // new_contributor_sim: add-only accepted, but non-empty removeLinks rejected.
  check(
    "new_contributor_sim add-only accepted",
    validateLinkEditsAgainstSnapshot({
      raw,
      parsed,
      contributorCode: NEW_CONTRIBUTOR_SIM_CODE,
      addLinks: [{ cityA: locX, cityZ: locY }],
      removeLinks: [],
    }).ok
  );
  check(
    "new_contributor_sim with removeLinks rejected",
    !validateLinkEditsAgainstSnapshot({
      raw,
      parsed,
      contributorCode: NEW_CONTRIBUTOR_SIM_CODE,
      addLinks: [],
      removeLinks: ["any-pubkey"],
    }).ok
  );

  // Contributor removal: stale pubkey rejected, real pubkey accepted.
  if (contribWithLinks) {
    const realPubkey = contribWithLinks.links[0].pubkey;
    check(
      "stale removal pubkey rejected",
      !validateLinkEditsAgainstSnapshot({
        raw,
        parsed,
        contributorCode: contribWithLinks.code,
        addLinks: [],
        removeLinks: ["stale-pubkey-not-real"],
      }).ok
    );
    check(
      "real removal pubkey accepted",
      validateLinkEditsAgainstSnapshot({
        raw,
        parsed,
        contributorCode: contribWithLinks.code,
        addLinks: [],
        removeLinks: [realPubkey],
      }).ok
    );
  } else {
    console.log("  skip removal tests (no contributor with links in snapshot)");
  }

  console.log(
    failures === 0 ? "\nALL PASS" : `\n${failures} assertion(s) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
