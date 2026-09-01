#!/usr/bin/env node
/**
 * Pubkey validation, vote-account stake resolution, and the stake route
 * (`lib/utils/pubkey.ts`, `lib/onchain/vote-stake.ts`,
 * `app/api/validators/stake/route.ts`).
 *
 * The pure section asserts the validator contract: never throws, rejects
 * before decoding so a huge input cannot burn CPU, stays case-sensitive, and
 * agrees byte-for-byte with the existing `pubkeyBytes` decoder on valid keys
 * so the repo does not end up with two subtly different base58 decoders.
 *
 * The resolver and route sections swap the RPC call for canned payloads via
 * `__testing.setFetchVoteAccounts`, so every branch runs with no network: the
 * filtered hit, the identity fallback, a provider that ignores the filter,
 * in-flight dedup, and each status the route can return with its caching.
 * The failure cases capture the `[obs:error]` line and assert it carries a
 * category and never the provider's message.
 *
 * The live section resolves real vote accounts against an RPC endpoint, so it
 * is opt-in.
 *
 * Usage:
 *   npx tsx scripts/test-validator-stake.ts
 *
 *   # Include the live RPC assertions:
 *   LIVE=1 SOLANA_RPC_URL=https://... npx tsx scripts/test-validator-stake.ts
 *
 * Exits non-zero on any failed assertion.
 */

import bs58 from "bs58";
import { NextRequest } from "next/server";

import { validatePubkey, isValidPubkey } from "../lib/utils/pubkey";
import { pubkeyBytes } from "../lib/utils/canonical-input-builder";
import {
  __testing,
  clearVoteStakeCache,
  resolveVoteAccountStake,
} from "../lib/onchain/vote-stake";
import {
  getVoteAccounts,
  RpcError,
  type GetVoteAccountsOpts,
  type VoteAccountInfo,
  type VoteAccountsResponse,
} from "../lib/onchain/client";
import { GET as getStake } from "../app/api/validators/stake/route";
import { LAMPORTS_PER_SOL } from "../lib/constants/config";

const LIVE = process.env.LIVE === "1";

// Highest-staked mainnet validator that is NOT in the DoubleZero publisher
// feed, verified against both the Foundation export and the malbec feed. The
// case this ticket exists for.
const HELIUS_VOTE = "he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk";
const HELIUS_IDENTITY = "HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU";

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

// ── canned RPC ───────────────────────────────────────────────────────────────

/** Deterministic 32-byte keys, so the offline sections need no fixture file
 *  and can never collide with a real validator. */
function fakePubkey(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (seed * 31 + i * 7 + 1) & 0xff;
  }
  return bs58.encode(bytes);
}

function voteAccount(
  votePubkey: string,
  nodePubkey: string,
  activatedStake: number,
  extra: Partial<VoteAccountInfo> = {},
): VoteAccountInfo {
  return {
    votePubkey,
    nodePubkey,
    activatedStake,
    epochVoteAccount: true,
    commission: 5,
    lastVote: 1_000,
    rootSlot: 900,
    epochCredits: [],
    ...extra,
  };
}

const VOTE_A = fakePubkey(1);
const NODE_A = fakePubkey(2);
// One identity running two vote accounts; the resolver must pick the larger.
const VOTE_B_SMALL = fakePubkey(3);
const VOTE_B_LARGE = fakePubkey(4);
const NODE_B = fakePubkey(5);
const VOTE_DELINQUENT = fakePubkey(6);
const NODE_DELINQUENT = fakePubkey(7);
const UNKNOWN = fakePubkey(8);
const UNKNOWN_2 = fakePubkey(9);

const WORLD: VoteAccountsResponse = {
  current: [
    voteAccount(VOTE_A, NODE_A, 5_000 * LAMPORTS_PER_SOL),
    voteAccount(VOTE_B_SMALL, NODE_B, 1_000 * LAMPORTS_PER_SOL),
    voteAccount(VOTE_B_LARGE, NODE_B, 9_000 * LAMPORTS_PER_SOL),
  ],
  delinquent: [
    voteAccount(VOTE_DELINQUENT, NODE_DELINQUENT, 0, {
      epochVoteAccount: false,
    }),
  ],
};

function filterWorld(votePubkey: string): VoteAccountsResponse {
  const match = (v: VoteAccountInfo) => v.votePubkey === votePubkey;
  return {
    current: WORLD.current.filter(match),
    delinquent: WORLD.delinquent.filter(match),
  };
}

type Handler = (
  opts: GetVoteAccountsOpts,
) => VoteAccountsResponse | Error | Promise<VoteAccountsResponse>;

/** A provider that honours `votePubkey`. */
const honouring: Handler = (opts) =>
  opts.votePubkey ? filterWorld(opts.votePubkey) : WORLD;

/** A provider that ignores the filter and returns everything. */
const ignoring: Handler = () => WORLD;

/** A provider that is down. The message carries what a real one can. */
const failing: Handler = () =>
  new Error("fetch failed: https://rpc.example/?api-key=SECRET");

interface FakeRpc {
  calls: GetVoteAccountsOpts[];
  restore: () => void;
}

/** Install a canned provider and reset the resolver's index. */
function installRpc(handler: Handler): FakeRpc {
  clearVoteStakeCache();
  const calls: GetVoteAccountsOpts[] = [];
  const restore = __testing.setFetchVoteAccounts(async (opts = {}) => {
    calls.push(opts);
    const out = await handler(opts);
    if (out instanceof Error) throw out;
    return out;
  });
  return { calls, restore };
}

/** Run `fn` with `console.error` captured, so a log line can be asserted on. */
async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logged: string }> {
  const original = console.error;
  let logged = "";
  console.error = (...args: unknown[]) => {
    logged += `${args.map(String).join(" ")}\n`;
  };
  try {
    const result = await fn();
    return { result, logged };
  } finally {
    console.error = original;
  }
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

async function resolverSection() {
  console.log("resolveVoteAccountStake — filtered hit:");
  {
    const rpc = installRpc(honouring);
    try {
      const r = await resolveVoteAccountStake(VOTE_A);
      check(
        "a vote pubkey resolves as found, matched by vote",
        r.status === "found" && r.matchedBy === "vote",
        r.status,
      );
      check(
        "the entry is the account asked for, not delinquent",
        r.status === "found" &&
          r.entry.votePubkey === VOTE_A &&
          r.entry.nodePubkey === NODE_A &&
          r.entry.activatedStake === 5_000 * LAMPORTS_PER_SOL &&
          r.entry.delinquent === false,
      );
      check(
        "one RPC call, no identity snapshot",
        rpc.calls.length === 1,
        String(rpc.calls.length),
      );
      const opts = rpc.calls[0];
      check("the filtered call carries votePubkey", opts.votePubkey === VOTE_A);
      check(
        "the filtered call sets keepUnstakedDelinquents: true",
        opts.keepUnstakedDelinquents === true,
      );
      check(
        "the filtered call bypasses the shared rpc cache",
        opts.ttlMs === 0,
        String(opts.ttlMs),
      );

      const d = await resolveVoteAccountStake(VOTE_DELINQUENT);
      check(
        "a delinquent-array entry is flagged delinquent, epochVoteAccount false",
        d.status === "found" &&
          d.entry.delinquent === true &&
          d.entry.epochVoteAccount === false &&
          d.entry.activatedStake === 0,
        d.status,
      );
    } finally {
      rpc.restore();
    }
  }

  console.log("resolveVoteAccountStake — identity fallback:");
  {
    const rpc = installRpc(honouring);
    try {
      const r = await resolveVoteAccountStake(NODE_B);
      check(
        "a node identity resolves, matched by identity",
        r.status === "found" && r.matchedBy === "identity",
        r.status,
      );
      check(
        "the larger of the identity's two vote accounts wins",
        r.status === "found" && r.entry.votePubkey === VOTE_B_LARGE,
        r.status === "found" ? r.entry.votePubkey : r.status,
      );
      check(
        "two RPC calls: filtered miss, then one snapshot",
        rpc.calls.length === 2,
        String(rpc.calls.length),
      );
      const snap = rpc.calls[1];
      check("the snapshot is unfiltered", snap.votePubkey === undefined);
      check(
        "the snapshot leaves keepUnstakedDelinquents off",
        snap.keepUnstakedDelinquents !== true,
      );
      check(
        "the snapshot bypasses the shared rpc cache",
        snap.ttlMs === 0,
        String(snap.ttlMs),
      );

      const miss = await resolveVoteAccountStake(UNKNOWN);
      check(
        "a key in neither set is not-found",
        miss.status === "not-found",
        miss.status,
      );
      check(
        "the miss reused the index: one more call, not two",
        rpc.calls.length === 3,
        String(rpc.calls.length),
      );
    } finally {
      rpc.restore();
    }
  }

  console.log("resolveVoteAccountStake — provider ignores the filter:");
  {
    const rpc = installRpc(ignoring);
    try {
      const r = await resolveVoteAccountStake(VOTE_B_SMALL);
      check(
        "the exact vote pubkey is matched, not current[0]",
        r.status === "found" &&
          r.matchedBy === "vote" &&
          r.entry.votePubkey === VOTE_B_SMALL,
        r.status,
      );
      const byId = await resolveVoteAccountStake(NODE_A);
      check(
        "the full payload primed the identity index",
        byId.status === "found" &&
          byId.matchedBy === "identity" &&
          byId.entry.votePubkey === VOTE_A,
        byId.status,
      );
      check(
        "so no separate snapshot was fetched",
        rpc.calls.every((c) => c.votePubkey !== undefined),
        `${rpc.calls.length} calls`,
      );
    } finally {
      rpc.restore();
    }
  }

  console.log("resolveVoteAccountStake — in-flight dedup:");
  {
    const slow: Handler = async (opts) => {
      if (opts.votePubkey) return filterWorld(opts.votePubkey);
      await new Promise((r) => setTimeout(r, 10));
      return WORLD;
    };
    const rpc = installRpc(slow);
    try {
      const [a, b] = await Promise.all([
        resolveVoteAccountStake(UNKNOWN),
        resolveVoteAccountStake(UNKNOWN_2),
      ]);
      check(
        "both concurrent misses settle as not-found",
        a.status === "not-found" && b.status === "not-found",
        `${a.status} ${b.status}`,
      );
      const snapshots = rpc.calls.filter(
        (c) => c.votePubkey === undefined,
      ).length;
      check(
        "two concurrent misses share one snapshot",
        snapshots === 1,
        String(snapshots),
      );
    } finally {
      rpc.restore();
    }
  }

  console.log("resolveVoteAccountStake — unavailable:");
  {
    const rpc = installRpc(failing);
    try {
      const { result, logged } = await captureStderr(() =>
        resolveVoteAccountStake(VOTE_A),
      );
      check(
        "a failed filtered call is unavailable",
        result.status === "unavailable",
        result.status,
      );
      check(
        "no identity snapshot is attempted after it",
        rpc.calls.length === 1,
        String(rpc.calls.length),
      );
      check(
        "the failure is logged by category",
        logged.includes("filtered lookup: unknown"),
        firstLine(logged),
      );
      check(
        "the log never carries the provider's message",
        !logged.includes("SECRET") && !logged.includes("api-key"),
      );
    } finally {
      rpc.restore();
    }
  }
  {
    // Filtered call succeeds empty; the snapshot fails with what a provider
    // that rejects a parameter returns.
    const rejecting: Handler = (opts) =>
      opts.votePubkey
        ? filterWorld(opts.votePubkey)
        : new RpcError(
            "jsonrpc",
            -32602,
            "Invalid params at https://rpc.example/?api-key=SECRET",
          );
    const rpc = installRpc(rejecting);
    try {
      const { result, logged } = await captureStderr(() =>
        resolveVoteAccountStake(UNKNOWN),
      );
      check(
        "a failed snapshot is unavailable, not not-found",
        result.status === "unavailable",
        result.status,
      );
      check(
        "an RpcError logs its kind and code",
        logged.includes("identity index: jsonrpc:-32602"),
        firstLine(logged),
      );
      check("and still not its message", !logged.includes("SECRET"));
    } finally {
      rpc.restore();
    }
  }
}

// ── route ────────────────────────────────────────────────────────────────────

interface RouteResult {
  status: number;
  cacheControl: string | null;
  retryAfter: string | null;
  text: string;
  body: Record<string, unknown>;
}

async function callRoute(
  query: string,
  headers?: Record<string, string>,
): Promise<RouteResult> {
  const res = await getStake(
    new NextRequest(`http://localhost/api/validators/stake${query}`, {
      headers,
    }),
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON body. `body` stays empty and `text` carries what came back.
  }
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control"),
    retryAfter: res.headers.get("retry-after"),
    text,
    body,
  };
}

function warningsOf(r: RouteResult): string[] {
  return Array.isArray(r.body.warnings) ? (r.body.warnings as string[]) : [];
}

async function routeSection() {
  console.log("GET /api/validators/stake — malformed input:");
  {
    const missing = await callRoute("");
    check("no pubkey → 400", missing.status === 400, String(missing.status));
    check(
      "reason: empty",
      missing.body.reason === "empty",
      String(missing.body.reason),
    );
    check(
      "error body carries hasStake false and activatedStake 0",
      missing.body.hasStake === false && missing.body.activatedStake === 0,
    );
    check(
      "400 is edge-cacheable",
      missing.cacheControl === "public, max-age=60",
      String(missing.cacheControl),
    );

    const typo = "O".repeat(40);
    const bad = await callRoute(`?pubkey=${typo}`);
    check(
      "excluded base58 char → 400 excluded-char",
      bad.status === 400 && bad.body.reason === "excluded-char",
      `${bad.status} ${String(bad.body.reason)}`,
    );
    check("the 400 body never echoes the input", !bad.text.includes(typo));
  }

  console.log("GET /api/validators/stake — found:");
  {
    const rpc = installRpc(honouring);
    try {
      const ok = await callRoute(`?pubkey=${VOTE_A}`);
      check("a vote account → 200", ok.status === 200, String(ok.status));
      check(
        "body maps the entry",
        ok.body.votePubkey === VOTE_A &&
          ok.body.nodePubkey === NODE_A &&
          ok.body.activatedStake === 5_000 * LAMPORTS_PER_SOL &&
          ok.body.activatedStakeSol === 5_000 &&
          ok.body.hasStake === true &&
          ok.body.matchedBy === "vote" &&
          ok.body.source === "rpc",
        ok.text,
      );
      check(
        "no warnings on a healthy staked account",
        warningsOf(ok).length === 0,
        JSON.stringify(ok.body.warnings),
      );
      check(
        "200 is cacheable at the edge",
        (ok.cacheControl ?? "").includes("s-maxage=60"),
        String(ok.cacheControl),
      );
      const before = rpc.calls.length;
      const again = await callRoute(`?pubkey=${VOTE_A}`);
      check(
        "a repeat within 60s is served from the hit cache",
        again.status === 200 && rpc.calls.length === before,
        `${rpc.calls.length} calls vs ${before}`,
      );

      const identity = await callRoute(`?pubkey=${NODE_A}`);
      check(
        "a node identity → 200 matched by identity",
        identity.status === 200 && identity.body.matchedBy === "identity",
        `${identity.status} ${String(identity.body.matchedBy)}`,
      );
      check(
        "body keeps the caller's key and names the resolved vote account",
        identity.body.pubkey === NODE_A && identity.body.votePubkey === VOTE_A,
      );
      check(
        "warnings carry identity-match",
        warningsOf(identity).includes("identity-match"),
        JSON.stringify(identity.body.warnings),
      );

      const delinquent = await callRoute(`?pubkey=${VOTE_DELINQUENT}`);
      check(
        "an unstaked delinquent account → 200 with hasStake false",
        delinquent.status === 200 && delinquent.body.hasStake === false,
        String(delinquent.status),
      );
      const warnings = warningsOf(delinquent);
      check(
        "warnings: delinquent, zero-stake, not-epoch-vote-account",
        ["delinquent", "zero-stake", "not-epoch-vote-account"].every((w) =>
          warnings.includes(w),
        ),
        JSON.stringify(warnings),
      );
    } finally {
      rpc.restore();
    }
  }

  console.log("GET /api/validators/stake — not found:");
  {
    const rpc = installRpc(honouring);
    try {
      const miss = await callRoute(`?pubkey=${UNKNOWN}`);
      check(
        "a well-formed non-vote-account → 404",
        miss.status === 404,
        String(miss.status),
      );
      check(
        "generic body, no reason field",
        miss.body.error === "Not a vote account" && !("reason" in miss.body),
        miss.text,
      );
      check("the 404 body never echoes the input", !miss.text.includes(UNKNOWN));
      check(
        "404 is edge-cacheable",
        miss.cacheControl === "public, max-age=60",
        String(miss.cacheControl),
      );
      const before = rpc.calls.length;
      const again = await callRoute(`?pubkey=${UNKNOWN}`);
      check(
        "a repeat is served from the miss cache",
        again.status === 404 && rpc.calls.length === before,
        `${rpc.calls.length} calls vs ${before}`,
      );
    } finally {
      rpc.restore();
    }
  }

  console.log("GET /api/validators/stake — upstream unavailable:");
  {
    const rpc = installRpc(failing);
    const key = fakePubkey(10);
    try {
      const { result: down, logged } = await captureStderr(() =>
        callRoute(`?pubkey=${key}`),
      );
      check("an RPC failure → 502", down.status === 502, String(down.status));
      check("generic body", down.body.error === "Stake lookup failed", down.text);
      check(
        "neither body nor log carries the provider's message",
        !down.text.includes("SECRET") &&
          !down.text.includes("api-key") &&
          !logged.includes("SECRET"),
      );
      check(
        "502 is not cached",
        down.cacheControl === "no-store",
        String(down.cacheControl),
      );
      const before = rpc.calls.length;
      await captureStderr(() => callRoute(`?pubkey=${key}`));
      check(
        "a repeat after a 502 retries upstream",
        rpc.calls.length === before + 1,
        `${rpc.calls.length} calls vs ${before + 1}`,
      );
    } finally {
      rpc.restore();
    }
  }

  console.log("GET /api/validators/stake — rate limit:");
  {
    const rpc = installRpc(honouring);
    try {
      // A distinct IP so the bucket starts empty and stays ours.
      const headers = { "x-real-ip": "203.0.113.7" };
      let allowed = 0;
      let limited: RouteResult | null = null;
      for (let i = 0; i < 61; i++) {
        const r = await callRoute(`?pubkey=${VOTE_A}`, headers);
        if (r.status === 429) {
          limited = r;
          break;
        }
        allowed += 1;
      }
      check("60 requests a minute pass", allowed === 60, String(allowed));
      check("the 61st is a 429", limited !== null && limited.status === 429);
      check(
        "with Retry-After and no-store",
        limited !== null &&
          limited.retryAfter !== null &&
          limited.cacheControl === "no-store",
        `${limited?.retryAfter} ${limited?.cacheControl}`,
      );
    } finally {
      rpc.restore();
    }
  }
}

// ── live ─────────────────────────────────────────────────────────────────────

async function liveSection() {
  if (!LIVE) {
    skip("live vote-account resolution (set LIVE=1 to run)");
    return;
  }
  clearVoteStakeCache();

  const hit = await resolveVoteAccountStake(HELIUS_VOTE);
  check(
    "a non-DoubleZero mainnet vote account resolves",
    hit.status === "found",
    hit.status,
  );
  if (hit.status === "found") {
    check("matched on the vote pubkey", hit.matchedBy === "vote", hit.matchedBy);
    check(
      "the returned entry is the one asked for",
      hit.entry.votePubkey === HELIUS_VOTE,
      hit.entry.votePubkey,
    );
    check(
      "activated stake is positive",
      hit.entry.activatedStake > 0,
      String(hit.entry.activatedStake),
    );
    console.log(
      `       stake=${(hit.entry.activatedStake / 1e9).toFixed(0)} SOL ` +
        `delinquent=${hit.entry.delinquent} commission=${hit.entry.commission}%`,
    );
  }

  const byIdentity = await resolveVoteAccountStake(HELIUS_IDENTITY);
  check(
    "the node identity resolves to the same vote account",
    byIdentity.status === "found" &&
      byIdentity.entry.votePubkey === HELIUS_VOTE,
    byIdentity.status,
  );
  if (byIdentity.status === "found") {
    check(
      "the identity match is labelled as such",
      byIdentity.matchedBy === "identity",
      byIdentity.matchedBy,
    );
  }

  // A DoubleZero program ID: valid 32-byte base58, certainly not a vote
  // account. Distinguishes not-found from unavailable, which the route maps
  // to 404 and 502 respectively.
  const miss = await resolveVoteAccountStake(REAL_KEYS[1]);
  check(
    "a program ID is not-found, not unavailable",
    miss.status === "not-found",
    miss.status,
  );

  // Provider property, not a code defect: the resolver guards against a
  // provider that ignores the filter, so warn rather than fail.
  const filtered = await getVoteAccounts({
    votePubkey: HELIUS_VOTE,
    keepUnstakedDelinquents: true,
    ttlMs: 0,
  });
  const returned = filtered.current.length + filtered.delinquent.length;
  if (returned > 1) {
    console.log(
      `  warn the endpoint ignored votePubkey and returned ${returned} entries;` +
        " the identity fallback is load-bearing here",
    );
  } else {
    check("the endpoint honours the votePubkey filter", returned <= 1);
  }

  // Pins the keepUnstakedDelinquents decision: without it, an unstaked
  // delinquent account is absent from both arrays and looks identical to a
  // pubkey that is not a vote account.
  const kept = await getVoteAccounts({ keepUnstakedDelinquents: true, ttlMs: 0 });
  const dropped = await getVoteAccounts({
    keepUnstakedDelinquents: false,
    ttlMs: 0,
  });
  const keptN = kept.current.length + kept.delinquent.length;
  const droppedN = dropped.current.length + dropped.delinquent.length;
  check(
    `keepUnstakedDelinquents:true returns a superset (${keptN} >= ${droppedN})`,
    keptN >= droppedN,
  );
}

async function main() {
  pureSection();
  await resolverSection();
  await routeSection();
  console.log("live:");
  await liveSection();

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall assertions passed");
}

void main();
