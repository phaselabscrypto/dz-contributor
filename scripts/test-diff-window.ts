#!/usr/bin/env node
/**
 * Window-validation parity test for `lib/utils/diff-window.ts`.
 *
 * The proxy at `app/api/diff/route.ts` is the only gate on the public surface,
 * and it must accept exactly what the Rust `validate_window` accepts
 * (`services/shapley-rs/src/diff.rs`) and emit the same three messages. This
 * asserts the accepted set, the rejected set, and the message strings.
 *
 * Pure input validation — no network, no snapshot, safe to run anywhere.
 *
 * Usage:
 *   npx tsx scripts/test-diff-window.ts
 *
 * Exits non-zero on any failed assertion.
 */

import {
  DIFF_CACHE_CONTROL,
  MAX_DIFF_EPOCH,
  MAX_DIFF_WINDOW,
  validateDiffWindow,
} from "../lib/utils/diff-window";
import { MIN_DZ_EPOCH } from "../lib/constants/config";

// services/shapley-rs/src/diff.rs:27-29
const REQUIRED = "from and to query params required (different integers)";
const BOUNDS = `from and to must be in [${MIN_DZ_EPOCH}, ${MAX_DIFF_EPOCH}]`;
const TOO_WIDE = `epoch window too wide: |to - from| must be <= ${MAX_DIFF_WINDOW}`;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function accepts(from: string, to: string, want: { from: number; to: number }) {
  const result = validateDiffWindow(from, to);
  check(
    `accepts (${from}, ${to})`,
    result.ok && result.from === want.from && result.to === want.to,
    JSON.stringify(result),
  );
}

function rejects(from: string | null, to: string | null, want: string) {
  const result = validateDiffWindow(from, to);
  check(
    `rejects (${from}, ${to})`,
    !result.ok && result.error === want,
    !result.ok ? `got "${result.error}"` : "accepted",
  );
}

console.log("Accepted windows");
accepts("48", "49", { from: 48, to: 49 });
accepts("204", "211", { from: 204, to: 211 });
accepts("211", "204", { from: 211, to: 204 }); // reversed is accepted, as in Rust
accepts(" 48 ", "49", { from: 48, to: 49 }); // trimmed, as in Rust
accepts("+48", "49", { from: 48, to: 49 });
accepts("0048", "49", { from: 48, to: 49 });
accepts(String(MIN_DZ_EPOCH), String(MIN_DZ_EPOCH + MAX_DIFF_WINDOW), {
  from: MIN_DZ_EPOCH,
  to: MIN_DZ_EPOCH + MAX_DIFF_WINDOW,
});

console.log("Rejected: not a pair of different integers");
rejects(null, "49", REQUIRED);
rejects("48", null, REQUIRED);
rejects("", "49", REQUIRED);
rejects("48", "48", REQUIRED);
// str::parse::<i64> rejects all of these, so the proxy must too. parseInt
// would have read them as 48, 48, 4, 1 and 0.
rejects("48abc", "49", REQUIRED);
rejects("48.9", "49", REQUIRED);
rejects("4 8", "49", REQUIRED);
rejects("1e5", "49", REQUIRED);
rejects("0x30", "49", REQUIRED);
rejects("NaN", "49", REQUIRED);

console.log("Rejected: out of bounds");
rejects("47", "49", BOUNDS);
rejects("-48", "49", BOUNDS);
rejects("0", "49", BOUNDS);
rejects("48", String(MAX_DIFF_EPOCH + 1), BOUNDS);

console.log("Rejected: window too wide");
rejects("48", String(48 + MAX_DIFF_WINDOW + 1), TOO_WIDE);
rejects(String(48 + MAX_DIFF_WINDOW + 1), "48", TOO_WIDE);

console.log("Cache-Control");
check(
  "successful bodies carry a shared-cache TTL",
  DIFF_CACHE_CONTROL.includes("s-maxage=86400"),
  DIFF_CACHE_CONTROL,
);

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall diff-window assertions passed");
