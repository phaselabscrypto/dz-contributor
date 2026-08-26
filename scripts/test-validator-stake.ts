#!/usr/bin/env node
/**
 * Pubkey validation and vote-account stake resolution tests
 * (`lib/utils/pubkey.ts`, `lib/onchain/vote-stake.ts`).
 *
 * The pure section asserts the validator contract: never throws, rejects
 * before decoding so a huge input cannot burn CPU, stays case-sensitive, and
 * agrees byte-for-byte with the existing `pubkeyBytes` decoder on valid keys
 * so the repo does not end up with two subtly different base58 decoders.
 *
 * A live section for vote-account resolution arrives with
 * `lib/onchain/vote-stake.ts`.
 *
 * Usage:
 *   npx tsx scripts/test-validator-stake.ts
 *
 * Exits non-zero on any failed assertion.
 */

import bs58 from "bs58";

import { validatePubkey, isValidPubkey } from "../lib/utils/pubkey";
import { pubkeyBytes } from "../lib/utils/canonical-input-builder";

// Real 32-byte base58 keys already committed to this repo, so the pure
// section needs no network and no fixture file.
const REAL_KEYS = [
  "ser2VaTMAcYTaauMrTSfSrxBaUDq7BLNs2xfUugTAGv",
  "dzrevZC94tBLwuHw1dyynZxaXTWyp7yocsinyEVPtt4",
];

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function skip(name: string) {
  console.log(`  skip ${name}`);
}

function reasonOf(raw: unknown): string {
  const r = validatePubkey(raw);
  return r.ok ? "ok" : r.reason;
}

function pureSection() {
  console.log("validatePubkey — rejects:");
  for (const [label, input] of [
    ["undefined", undefined],
    ["null", null],
    ["number", 123],
    ["empty string", ""],
    ["whitespace only", "   "],
  ] as const) {
    check(`${label} → empty`, reasonOf(input) === "empty", reasonOf(input));
  }

  const short = "1".repeat(31);
  const long = "1".repeat(45);
  check("31 chars → too-short", reasonOf(short) === "too-short", reasonOf(short));
  check("45 chars → too-long", reasonOf(long) === "too-long", reasonOf(long));

  // Four separate assertions, so three cannot regress silently.
  for (const ch of ["0", "O", "I", "l"]) {
    const input = ch + "1".repeat(42);
    check(
      `contains '${ch}' → excluded-char`,
      reasonOf(input) === "excluded-char",
      reasonOf(input),
    );
  }

  const badChar = "$".repeat(40);
  check(
    "non-base58 chars → non-base58",
    reasonOf(badChar) === "non-base58",
    reasonOf(badChar),
  );

  check(
    "32 leading '1's → default-pubkey (all-zero)",
    reasonOf("1".repeat(32)) === "default-pubkey",
    reasonOf("1".repeat(32)),
  );

  // Pins the length-check-before-decode ordering. bs58 decodes via base-x,
  // which is quadratic, so without the length gate this would not return
  // promptly.
  const huge = "1".repeat(100_000);
  const t0 = performance.now();
  const hugeReason = reasonOf(huge);
  const elapsed = performance.now() - t0;
  check(
    "100k-char input → too-long",
    hugeReason === "too-long",
    hugeReason,
  );
  check(
    `100k-char input rejected in under 5ms (took ${elapsed.toFixed(2)}ms)`,
    elapsed < 5,
    `${elapsed.toFixed(2)}ms — length gate may have moved after the decode`,
  );

  console.log("validatePubkey — accepts:");
  for (const key of REAL_KEYS) {
    const r = validatePubkey(key);
    check(`${key.slice(0, 8)}… accepted`, r.ok, r.ok ? "" : r.reason);
    if (!r.ok) continue;
    check(
      `${key.slice(0, 8)}… decodes to 32 bytes`,
      r.bytes.length === 32,
      String(r.bytes.length),
    );
    check(
      `${key.slice(0, 8)}… pubkey preserved verbatim`,
      r.pubkey === key,
      r.pubkey,
    );
    check(
      `${key.slice(0, 8)}… round-trips through bs58`,
      bs58.encode(r.bytes) === key,
      bs58.encode(r.bytes),
    );
    // Guards against the repo gaining a second, divergent base58 decoder.
    const legacy = pubkeyBytes(key);
    check(
      `${key.slice(0, 8)}… agrees with pubkeyBytes`,
      legacy.length === r.bytes.length &&
        legacy.every((b, i) => b === r.bytes[i]),
      `legacy=${legacy.length}B new=${r.bytes.length}B`,
    );
  }

  check("whitespace is trimmed", (() => {
    const r = validatePubkey(`  ${REAL_KEYS[0]}  `);
    return r.ok && r.pubkey === REAL_KEYS[0];
  })());

  console.log("validatePubkey — case sensitivity:");
  // Lowercasing must not be introduced for symmetry with the old
  // publisher-array search, which compared case-insensitively.
  const mixed = REAL_KEYS[0];
  const lowered = mixed.toLowerCase();
  check("input has uppercase to test with", mixed !== lowered);
  check(
    "lowercased form is a different key or invalid",
    (() => {
      const a = validatePubkey(mixed);
      const b = validatePubkey(lowered);
      if (!b.ok) return true;
      if (!a.ok) return false;
      return !a.bytes.every((byte, i) => byte === b.bytes[i]);
    })(),
    "lowercasing produced the same bytes — validator is case-insensitive",
  );

  console.log("isValidPubkey:");
  check("agrees with validatePubkey on a real key", isValidPubkey(REAL_KEYS[0]));
  check("agrees with validatePubkey on garbage", !isValidPubkey("notabase58key"));
  check("never throws on a hostile value", (() => {
    try {
      isValidPubkey({ toString() { throw new Error("boom"); } });
      return true;
    } catch {
      return false;
    }
  })());
}

async function liveSection() {
  // Vote-account resolution assertions land with `lib/onchain/vote-stake.ts`.
  skip("live vote-account resolution (not implemented yet)");
}

async function main() {
  pureSection();
  console.log("live:");
  await liveSection();

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall assertions passed");
}

void main();
