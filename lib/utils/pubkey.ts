/**
 * Solana pubkey validation for user-supplied input.
 *
 * The earnings calculator accepts a vote account typed or pasted by a
 * contributor, so the string is hostile input rather than a value the app
 * produced. Nothing in the repo validated a pubkey before this: the closest
 * thing, `pubkeyBytes` in `lib/utils/canonical-input-builder.ts`, throws on a
 * bad character and never checks the decoded length, so it accepts `"abc"` and
 * returns two bytes. It also underwrites the device-ordering parity with the
 * Rust builder, so widening its contract is not free.
 *
 * Follows the two-stage validator contract from `lib/utils/link-edits.ts`:
 * pure, never throws, returns a discriminated-union `Result` so a route can
 * turn `ok: false` into `NextResponse.json({ error }, 400)` and callers cannot
 * drift.
 *
 * Case matters. `O` and `l` are outside the base58 alphabet while `o` and `L`
 * are inside it, so lowercasing a typo silently produces a different
 * well-formed key. The validated string also becomes an RPC parameter and a
 * cache key, where aliasing two inputs onto one entry would serve one
 * validator's stake for another.
 */

import bs58 from "bs58";

/**
 * Length bounds, checked before any decode. 32 zero bytes encode as 32 `1`
 * characters, and 2^256 needs at most 44 base58 digits, so the range cannot
 * reject a real key. Its job is to bound the work: `bs58` decodes via `base-x`,
 * which is quadratic in input length, so a megabyte-long query string would
 * otherwise burn CPU inside the decoder.
 */
const B58_MIN_LEN = 32;
const B58_MAX_LEN = 44;

/** A Solana pubkey is 32 bytes. This is the authoritative check. */
const PUBKEY_BYTES = 32;

/**
 * Characters base58 omits because they are the common transcription errors.
 * Called out separately so the UI can say "check for a typo" rather than the
 * generic "not valid base58".
 */
const EXCLUDED_CHARS = "0OIl";

/** Why a candidate was rejected. Describes the caller's own input, so it is
 *  safe to return in a public response body. */
export type PubkeyRejectReason =
  | "empty"
  | "too-short"
  | "too-long"
  | "excluded-char"
  | "non-base58"
  | "wrong-byte-length"
  | "default-pubkey";

/** A validated pubkey. `pubkey` is trimmed but otherwise byte-for-byte the
 *  caller's input, and `bytes` is always length 32. */
export interface ValidPubkey {
  ok: true;
  pubkey: string;
  bytes: Uint8Array;
}

export interface InvalidPubkey {
  ok: false;
  reason: PubkeyRejectReason;
  /** Fixed message, safe to return verbatim. Never contains the input. */
  error: string;
}

export type PubkeyResult = ValidPubkey | InvalidPubkey;

const MESSAGES: Record<PubkeyRejectReason, string> = {
  empty: "pubkey parameter required",
  "too-short": `pubkey must be a ${B58_MIN_LEN}-${B58_MAX_LEN} character base58 string`,
  "too-long": `pubkey must be a ${B58_MIN_LEN}-${B58_MAX_LEN} character base58 string`,
  "excluded-char":
    "pubkey contains a character that is not valid base58 (0, O, I and l are excluded)",
  "non-base58": "pubkey is not valid base58",
  "wrong-byte-length": `pubkey must decode to ${PUBKEY_BYTES} bytes`,
  "default-pubkey": "pubkey is the default (all-zero) address",
};

function reject(reason: PubkeyRejectReason): InvalidPubkey {
  return { ok: false, reason, error: MESSAGES[reason] };
}

/**
 * Validate a caller-supplied Solana pubkey.
 *
 * Accepts `unknown` so a route can pass `searchParams.get(...)` or a raw JSON
 * body field straight in. Pure and never throws.
 *
 * @param raw - candidate pubkey, typically a query param or form field
 * @returns `{ ok: true, pubkey, bytes }`, or `{ ok: false, reason, error }`
 */
export function validatePubkey(raw: unknown): PubkeyResult {
  if (typeof raw !== "string") return reject("empty");
  const pubkey = raw.trim();
  if (!pubkey) return reject("empty");

  if (pubkey.length < B58_MIN_LEN) return reject("too-short");
  if (pubkey.length > B58_MAX_LEN) return reject("too-long");

  for (const ch of pubkey) {
    if (EXCLUDED_CHARS.includes(ch)) return reject("excluded-char");
  }

  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(pubkey);
  } catch {
    // bs58 throws on any character outside its alphabet. The specific
    // character is not reported back, per the no-input-echo rule.
    return reject("non-base58");
  }

  if (bytes.length !== PUBKEY_BYTES) return reject("wrong-byte-length");
  if (bytes.every((b) => b === 0)) return reject("default-pubkey");

  return { ok: true, pubkey, bytes };
}

/**
 * Boolean form of `validatePubkey`, for client-side field state where the
 * reason is not needed. Pure and never throws.
 */
export function isValidPubkey(raw: unknown): boolean {
  return validatePubkey(raw).ok;
}
