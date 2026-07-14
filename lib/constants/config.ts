export const S3_SNAPSHOT_URL_TEMPLATE =
  "https://doublezero-contributor-rewards-mn-beta-snapshots.s3.us-east-1.amazonaws.com/mn-epoch-{N}-snapshot.json";

export const FEE_CSV_URL_TEMPLATE =
  "https://raw.githubusercontent.com/doublezerofoundation/fees/main/epoch/fees_{N}.csv";

export const FEE_CONSOLIDATED_URL =
  "https://raw.githubusercontent.com/doublezerofoundation/fees/main/fees_and_payments_consolidated.csv";

// DZ epoch floor — the earliest snapshot the Foundation publishes on S3.
// We deliberately do NOT pin a maximum because the network keeps producing
// new epochs (~149 at time of writing, climbing every ~2 days). Routes that
// need the latest epoch call `discoverLatest()` in `app/api/epochs/route.ts`;
// routes that take an `epoch` param sanity-check `epoch >= MIN_DZ_EPOCH` and
// let the S3 404 reject non-existent epochs.
export const MIN_DZ_EPOCH = 48;

// Max focus-owned links the per-link breakdown can solve. The breakdown is an
// EXACT 2^players Shapley game (one player per focus link + an "Others"
// pseudo-operator), so it's only tractable to ~20 players. Mirrors the Rust
// service's `SWEEP_MAX_FOCUS_LINKS` and the DZ reference's own limit
// (`network_linkestimate.py` asserts n_ops <= 20). Operators above this can't be
// broken down link-by-link by either implementation — gate before requesting.
export const MAX_BREAKDOWN_FOCUS_LINKS = 19;

// Canonical Shapley solver service.
//
// `SHAPLEY_SERVICE_URL` should point at the Rust microservice in
// `services/shapley-rs` (deployed to Cloud Run / Lambda) which wraps
// the canonical `network-shapley-rs` LP solver.
//
// When the env var is set, every Shapley route requires the remote
// solver — failures return 502 instead of silently swapping to a local
// heuristic (PR #7 review). When the env var is unset (local dev only),
// the routes serve `local-ts-heuristic-DEV-ONLY` results so the
// non-canonical path is impossible to miss.
//
// `PYTHON_SHAPLEY_URL` is retained for backwards compatibility with the
// previous Python deployment and is treated as an alias.
//
// We validate the URL shape at module load so a malformed env var
// (e.g. missing scheme, junk paste) fails loudly during startup rather
// than crashing inside `fetch()` on the first user request.
function validateShapleyServiceUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    // Strip trailing slash so callers can append `/shapley` / `/link-estimate`
    // without producing double slashes.
    return trimmed.replace(/\/$/, "");
  } catch (err) {
    throw new Error(
      `SHAPLEY_SERVICE_URL is not a valid URL: ${
        err instanceof Error ? err.message : String(err)
      }. Set it to the base URL of the Rust solver (e.g. https://dz-shapley.example.run.app), or unset it to fall back to the in-process TS solver.`,
    );
  }
}

export const SHAPLEY_SERVICE_URL = validateShapleyServiceUrl(
  process.env.SHAPLEY_SERVICE_URL ?? process.env.PYTHON_SHAPLEY_URL,
);

/**
 * Build a URL for a Rust Shapley service endpoint.
 *
 * `SHAPLEY_SERVICE_URL` may be configured as any of:
 *   - bare base:        https://x.example
 *   - with trailing /:  https://x.example/
 *   - with /shapley:    https://x.example/shapley
 *   - with /link-est:   https://x.example/link-estimate
 *
 * Strips any known endpoint suffix before appending the requested one,
 * so an env var configured with `/shapley` doesn't make the
 * link-estimate caller produce `.../shapley/link-estimate` (a 404) —
 * every caller works regardless of how the operator set the env var.
 *
 * Returns null if `SHAPLEY_SERVICE_URL` is unset — callers fall back
 * to the in-process TS solver.
 */
const KNOWN_SHAPLEY_ENDPOINTS = [
  "/shapley",
  "/simulate",
  "/link-estimate",
  "/health",
];

/**
 * Base URL of the Rust service with any known endpoint suffix stripped.
 * Used for non-fixed paths like the async job API (`/jobs/simulate`,
 * `/jobs/{id}`). Returns null when `SHAPLEY_SERVICE_URL` is unset.
 */
export function shapleyServiceBase(): string | null {
  if (!SHAPLEY_SERVICE_URL) return null;
  let base = SHAPLEY_SERVICE_URL.replace(/\/+$/, "");
  for (const known of KNOWN_SHAPLEY_ENDPOINTS) {
    if (base.endsWith(known)) {
      base = base.slice(0, -known.length);
      break;
    }
  }
  return base;
}

export function shapleyEndpointUrl(
  endpoint: "/shapley" | "/simulate" | "/link-estimate" | "/health",
): string | null {
  const base = shapleyServiceBase();
  return base === null ? null : `${base}${endpoint}`;
}

// Economics — 45/45/10 split
export const BURN_RATE = 0.10; // 10% of revenue burned
export const CONTRIBUTOR_SHARE = 0.45; // 45% distributed to contributors (Shapley)
export const VALIDATOR_SHARE = 0.45; // 45% distributed to validators (stake-weighted)

// Validator/client revenue split inside the 45% validator pool.
// Confirmed by DZ Foundation: validators must share the pool
// 65/35 with their clients. A validator's actual take is
//   stake_share × pool × VALIDATOR_TAKE_OF_POOL
// Eligibility: must publish leader shreds AND must not publish
// retransmits. Anyone failing either gets zero rewards.
export const VALIDATOR_TAKE_OF_POOL = 0.65;
export const CLIENT_TAKE_OF_POOL = 0.35;
export const LAMPORTS_PER_SOL = 1_000_000_000;
// Solana epochs are ~2.2 days on current mainnet config — 30 / 2.2 ≈ 13.6.
// Rounded to 13 to stay conservative for forward projections. Bump if
// epoch length changes (e.g. shred-rate proposals); the projection routes
// surface this constant rather than baking the number inline.
export const EPOCHS_PER_MONTH = 13;
export const EPOCHS_PER_YEAR = 166; // 13 × 12.77 ≈ 166 epochs/year

// Shapley tuning parameters used by the fallback input builders
// (`shapley-input-builder.ts`, `live-shapley-input.ts`). These MUST mirror the
// constants in the canonical builder (`canonical-input-builder.ts`), which is
// verified byte-for-byte against the DZ Rust reference on mainnet epoch 149 —
// otherwise rewards computed via the fallback path are scaled differently from
// the canonical path. Keep them in lockstep.
//   demandMultiplier was 1.2 here (a stale pre-canonical guess from the initial
//   commit); the verified epoch-149 value is 1.0. Corrected to remove the drift.
export const SHAPLEY_PARAMS = {
  operatorUptime: 0.98, // canonical OPERATOR_UPTIME
  contiguityBonus: 5.0, // canonical CONTIGUITY_BONUS
  demandMultiplier: 1.0, // canonical DEMAND_MULTIPLIER (epoch-149 verified)
};

/**
 * Parse a float env var; fall back to `fallback` when unset, empty, non-numeric,
 * or negative. Mirrors the env-driven config pattern used above for
 * `SHAPLEY_SERVICE_URL`.
 */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Canonical-builder reward params — the two knobs that define DoubleZero's
// CURRENT (post-#369) reward methodology. Defaults mirror DZ's shipped
// `contributor-rewards` config (example.config.toml: `[demand] priority = 20.0`,
// `[input] public_latency_multiplier = 1.25`) and are env-overridable exactly as
// DZ's config is ("all fields can be overridden via environment variables").
//
// The canonical builder now targets DZ-current and is empirically parity-verified
// against DZ's own `export shapley` at epoch 184 (max |Δproportion| = 2.35e-15;
// see ~/.claude/plans/dz-contributor-dz-export-okd-parity_walkthrough.md).
// Epoch-149 HISTORICAL values were ibrlPriority 0.0 / publicLatencyMultiplier 1.0
// (pre-#369); reproduce a pre-#369 epoch by passing an explicit override to
// `buildCanonicalShapleyInput` or setting the envs below.
//
// NOTE: the fallback builders (`shapley-input-builder.ts`, `live-shapley-input.ts`)
// do NOT yet consume these two params (they still emit priority 0 / raw latency) —
// a tracked follow-up; the canonical/production reward path uses the values here.
export const CANONICAL_SHAPLEY_PARAMS = {
  ibrlPriority: numEnv("DZ_IBRL_PRIORITY", 20.0),
  publicLatencyMultiplier: numEnv("DZ_PUBLIC_LATENCY_MULTIPLIER", 1.25),
};

export function getSnapshotUrl(epoch: number): string {
  return S3_SNAPSHOT_URL_TEMPLATE.replace("{N}", epoch.toString());
}

export function getFeeCsvUrl(epoch: number): string {
  return FEE_CSV_URL_TEMPLATE.replace("{N}", epoch.toString());
}

// ────────────────────────────────────────────────────────────────────────
// Contributor display metadata
// ────────────────────────────────────────────────────────────────────────
//
// The hardcoded maps below are CURATED brand styling for known operators.
// They are the source of truth when present, but they are NOT the only
// source — anything not in these tables falls back to deterministic
// auto-generation so the site keeps working when a new contributor joins
// on-chain without code changes. See `getContributorDisplayName` and
// `getContributorColor`.

/**
 * Contributor code → curated full display name.
 *
 * Curated entries override the auto-generated title-case for cases where
 * the official brand name differs from the on-chain code (e.g. "jump_" →
 * "Jump Crypto" rather than "Jump"). Add a new entry here whenever a
 * contributor's branded name doesn't match the on-chain code shape.
 */
export const CONTRIBUTOR_NAMES: Record<string, string> = {
  "jump_": "Jump Crypto",
  "dgt": "Distributed Global",
  "tsw": "Teraswitch",
  "glxy": "Galaxy Digital",
  "stakefac": "Staking Facilities",
  "cherry": "Cherry Servers",
  "rox": "RockawayX",
  "s3v": "South 3rd Ventures",
  "laconic": "Laconic Network",
  "infiber": "InFiber",
  "cdrw": "Cumberland/DRW",
  "latitude": "Latitude.sh",
  "velia": "Velia.net",
  "allnodes": "Allnodes",
};

/**
 * Title-case an on-chain code into a display string.
 *   "infiber"   → "Infiber"
 *   "jump_"     → "Jump"           (trailing _ stripped)
 *   "cdrw"      → "Cdrw"           (all-caps acronyms are awkward —
 *                                    curate via CONTRIBUTOR_NAMES if you
 *                                    want "CDRW" / "Cumberland/DRW")
 */
function autoGenerateDisplayName(code: string): string {
  const stripped = code.replace(/[_\-]+$/g, "");
  if (!stripped) return code;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
}

// Track which unknown codes we've already warned about so we don't log
// the same one on every render. Cleared per server boot / page load.
const warnedUnknownContributors = new Set<string>();

export function getContributorDisplayName(code: string): string {
  const curated = CONTRIBUTOR_NAMES[code];
  if (curated) return curated;
  // Unknown code — auto-generate AND warn (once per code) so ops sees
  // the missing curated mapping. Auto-generated names are deterministic
  // and Phase-themed, so the UI degrades gracefully while we wait to
  // add the proper branding entry.
  if (code && !warnedUnknownContributors.has(code)) {
    warnedUnknownContributors.add(code);
    if (typeof console !== "undefined") {
      console.warn(
        `[contributor-directory] Unknown contributor code "${code}" — ` +
          `add it to CONTRIBUTOR_NAMES / CONTRIBUTOR_COLORS in lib/constants/config.ts`,
      );
    }
  }
  return autoGenerateDisplayName(code);
}

/**
 * Contributor code → curated color from the warm-tone palette.
 *
 * Curated entries pair each known operator with a hand-picked Phase-brand
 * accent. New operators fall back to a deterministic hash of the code
 * mapped into the same palette (see `autoGenerateColor`), so colors
 * stay stable across reloads + theme switches even for unmapped codes.
 */
export const CONTRIBUTOR_COLORS: Record<string, string> = {
  jump_: "#FF6B6B",   // coral red
  dgt: "#4ECDC4",     // teal
  tsw: "#F0B27A",     // sandy orange
  glxy: "#96CEB4",    // sage green
  stakefac: "#FFEAA7", // butter yellow
  cherry: "#E8A0BF",  // dusty rose
  rox: "#98D8C8",     // mint
  s3v: "#F7DC6F",     // gold
  laconic: "#D4A574",  // warm tan
  infiber: "#82E0AA",  // emerald
  cdrw: "#F1948A",    // salmon
  latitude: "#A3D9A5", // spring green
  velia: "#EDCC8B",   // warm sand
  allnodes: "#C9B99A", // khaki
};

/**
 * Phase-brand palette for auto-generated contributor colors. Warm tones
 * only (no blue, no purple) so auto-generated entries blend with the
 * curated CONTRIBUTOR_COLORS above.
 */
const AUTOGEN_PALETTE = [
  "#FF8A65", "#FFB74D", "#FFD54F", "#DCE775", "#AED581",
  "#81C784", "#4DB6AC", "#9CCC65", "#F4A261", "#E76F51",
  "#F1C27D", "#E8B86D", "#D4A574", "#C2A878", "#B8956A",
];

function hashCode(code: string): number {
  // FNV-1a 32-bit — fast, stable, deterministic across reloads.
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function autoGenerateColor(code: string): string {
  if (!code) return "#F3EED9";
  return AUTOGEN_PALETTE[hashCode(code) % AUTOGEN_PALETTE.length];
}

export function getContributorColor(code: string): string {
  return CONTRIBUTOR_COLORS[code] ?? autoGenerateColor(code);
}

/**
 * Economic-hub uses display-style names ("JumpCrypto", "Galaxy") whereas
 * topology data uses short codes ("jump_", "glxy"). Map between them so we
 * can join real reward percentages onto contributor records.
 */
export const ECONOMIC_HUB_NAME_TO_CODE: Record<string, string> = {
  JumpCrypto: "jump_",
  "Distributed Global Technologies": "dgt",
  Galaxy: "glxy",
  "Staking Facilities": "stakefac",
  "Cherry Servers": "cherry",
  RockawayX: "rox",
  "Infinite Fiber": "infiber",
  Teraswitch: "tsw",
  s3v: "s3v",
  "Cumberland/DRW": "cdrw",
  Laconic: "laconic",
  Latitude: "latitude",
  VELIA: "velia",
  Allnodes: "allnodes",
};

// Reverse lookup of CONTRIBUTOR_NAMES, built lazily. Lets us match
// economic-hub names against curated brand strings without doubling the
// maintenance cost of every new contributor.
let _curatedNameToCodeCache: Map<string, string> | null = null;
function curatedNameToCode(): Map<string, string> {
  if (!_curatedNameToCodeCache) {
    const m = new Map<string, string>();
    for (const [code, displayName] of Object.entries(CONTRIBUTOR_NAMES)) {
      m.set(displayName, code);
    }
    _curatedNameToCodeCache = m;
  }
  return _curatedNameToCodeCache;
}

export function ehNameToCode(name: string): string {
  // Exact-match the curated EH-specific map first (covers "JumpCrypto" →
  // "jump_" where the EH name doesn't match the brand display string).
  const exact = ECONOMIC_HUB_NAME_TO_CODE[name];
  if (exact) return exact;
  // Then check whether `name` already matches a curated brand display
  // string (e.g. EH ships "Jump Crypto" → "jump_" via reverse-lookup).
  const fromCurated = curatedNameToCode().get(name);
  if (fromCurated) return fromCurated;
  // Final fallback: normalise the name and hope it matches an on-chain
  // code. Doesn't always work, but stable + visible — caller can log.
  return name.toLowerCase().replace(/\s+/g, "");
}
