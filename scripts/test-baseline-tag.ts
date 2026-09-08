#!/usr/bin/env node
/**
 * Tag-format test for `baselineTag` in `lib/utils/sweep-tag.ts`.
 *
 * The tag is the only key the cron and the readers share: the cron publishes
 * the epoch alias under it and every probe asks for it back. It has to be
 * deterministic, epoch-distinct, and safe in a query string.
 *
 * Pure: no network, safe to run anywhere.
 *
 * Usage:
 *   npx tsx scripts/test-baseline-tag.ts
 *
 * Exits non-zero on any failed assertion.
 */

import { baselineTag, sweepTag } from "../lib/utils/sweep-tag";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const tag = baselineTag(211);

check(
  "shape is baseline:epoch-N:canonical-v1:<8 hex>",
  /^baseline:epoch-211:canonical-v1:[0-9a-f]{8}$/.test(tag),
  tag,
);
check("prefixes the sweep tag", tag === `baseline:${sweepTag(211)}`, tag);
check("deterministic", baselineTag(211) === tag);
check("epoch-distinct", baselineTag(210) !== tag);
check(
  "survives a query-string round trip",
  new URL(
    `http://x/shapley/baseline?tag=${encodeURIComponent(tag)}`,
  ).searchParams.get("tag") === tag,
);
check("no whitespace or NUL", !/[\s\u0000]/.test(tag), JSON.stringify(tag));
check(
  "well under the service's 256-byte tag cap",
  Buffer.byteLength(tag, "utf8") < 256,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
