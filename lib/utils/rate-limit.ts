/**
 * Per-instance, in-memory rate limiter.
 *
 * Fixed-window sliding counter keyed on caller IP. Persists for the
 * lifetime of a single Vercel function instance (typically minutes,
 * not hours — Vercel cycles instances regularly). That means:
 *
 *   - A single very chatty IP gets rate-limited within an instance,
 *     but the limit is effectively N × replica_count across the fleet
 *   - When Vercel scales out, fresh instances start with empty buckets
 *
 * Trade-off: no external infra dependency (no Redis, no Upstash, no
 * per-deploy cost), at the cost of fleet-wide accuracy. For the routes
 * we apply it to (compute-heavy Shapley + snapshot diff), this is fine
 * — the goal is to throttle pathological retries from a single client,
 * not to enforce a global SLA.
 *
 * When ops needs fleet-wide accuracy (or sub-second windows), swap the
 * implementation for `@upstash/ratelimit` against a free-tier Redis;
 * the consumer API here (`checkRateLimit(req, opts)`) won't change.
 */

import { NextResponse } from "next/server";

export interface RateLimitOpts {
  /** Identifier prefix — distinguishes buckets across routes. */
  bucket: string;
  /** Maximum requests permitted within `windowSec`. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

interface BucketEntry {
  count: number;
  /** Unix ms when this entry's window resets. */
  resetAt: number;
}

// Module-level state. Single shared map per instance.
const buckets = new Map<string, BucketEntry>();
// Soft cap so a worst-case IP-explosion attack can't OOM us. Buckets
// older than `MAX_AGE_MS` are evicted; the most recently-active 1000
// keys stay resident. In practice the eviction logic below keeps the
// map size bounded by `MAX_BUCKET_KEYS` regardless of window length.
const MAX_BUCKET_KEYS = 10_000;
const MAX_AGE_MS = 10 * 60 * 1000;

function evictStale(now: number): void {
  // Time-based purge first (O(n) but fast for any reasonable n).
  for (const [k, v] of buckets) {
    if (v.resetAt + MAX_AGE_MS < now) buckets.delete(k);
  }
  // If still over hard cap, evict the oldest entries by `resetAt`.
  if (buckets.size > MAX_BUCKET_KEYS) {
    const sorted = [...buckets.entries()].sort(
      (a, b) => a[1].resetAt - b[1].resetAt,
    );
    const overflow = buckets.size - MAX_BUCKET_KEYS;
    for (let i = 0; i < overflow; i++) {
      buckets.delete(sorted[i][0]);
    }
  }
}

/**
 * Resolve the caller's IP from request headers.
 *
 * On Vercel both `x-real-ip` and `x-forwarded-for` are set by the edge
 * proxy. We prefer `x-real-ip` because it's the single source-of-truth
 * client IP that Vercel writes — `x-forwarded-for` is a chain that an
 * attacker can prepend to from outside the trust boundary on platforms
 * with looser proxy setups, so trusting the leftmost entry there is the
 * classic spoofing vector. `x-forwarded-for` is kept only as a
 * non-Vercel fallback (local dev, custom proxies).
 *
 * Returns `null` when no trusted IP can be identified. Callers MUST NOT
 * share a single bucket across unknown callers — that lets one bad
 * actor without headers exhaust the limit for everyone else. Instead we
 * refuse to track the request and let it proceed (rate-limiting is an
 * advisory layer, not the only line of defence).
 */
function callerIp(req: Request): string | null {
  const xri = req.headers.get("x-real-ip");
  if (xri && xri.trim()) return xri.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

export interface RateLimitDecision {
  /** True if the request should proceed. */
  allowed: boolean;
  /** Requests remaining in the current window. */
  remaining: number;
  /** Seconds until the window resets (only set when blocked). */
  retryAfterSec?: number;
}

/**
 * Check whether a request is within its rate limit. Call this at the
 * top of route handlers; if `allowed === false`, return the response
 * from `rateLimitResponse(decision)` immediately.
 */
export function checkRateLimit(
  req: Request,
  opts: RateLimitOpts,
): RateLimitDecision {
  const now = Date.now();
  // Cheap probabilistic eviction so we don't sweep on every call.
  if (Math.random() < 0.01) evictStale(now);

  const ip = callerIp(req);
  // If we can't identify the caller from a trusted header, skip
  // tracking entirely. Letting all unknown-IP callers share a single
  // bucket would let one bad actor without headers exhaust the limit
  // for everyone. The request proceeds — rate-limiting is advisory.
  if (ip === null) {
    return { allowed: true, remaining: opts.limit };
  }
  const key = `${opts.bucket}:${ip}`;
  const windowMs = opts.windowSec * 1000;

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: opts.limit - 1 };
  }

  if (existing.count >= opts.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return { allowed: true, remaining: opts.limit - existing.count };
}

/**
 * Build the canonical 429 response when a request fails the rate-limit
 * check. Sets `Retry-After` so well-behaved clients back off naturally.
 *
 * The bucket identifier is intentionally NOT included in the response
 * body — it would leak internal routing topology (e.g. "shapley-simulate"
 * advertises that the solver exists and is segmented). The bucket is
 * kept server-side only (logged via reportEvent if needed).
 */
export function rateLimitResponse(
  decision: RateLimitDecision,
): NextResponse {
  return NextResponse.json(
    {
      error: "Too many requests",
      retryAfterSec: decision.retryAfterSec ?? 60,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(decision.retryAfterSec ?? 60),
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * Convenience: check + auto-respond. If the request is rate-limited,
 * returns the 429 response; otherwise returns null and the caller
 * should proceed.
 *
 *   const limited = enforceRateLimit(req, { bucket, limit, windowSec });
 *   if (limited) return limited;
 */
export function enforceRateLimit(
  req: Request,
  opts: RateLimitOpts,
): NextResponse | null {
  const decision = checkRateLimit(req, opts);
  if (decision.allowed) return null;
  return rateLimitResponse(decision);
}

// ────────────────────────────────────────────────────────────────────
// Recommended bucket presets — keep limit tuning in one place
// ────────────────────────────────────────────────────────────────────

/** Compute-heavy routes (Shapley solver, snapshot diffing). */
export const RATE_LIMIT_HEAVY: Omit<RateLimitOpts, "bucket"> = {
  limit: 10,
  windowSec: 60,
};

/** Default cap for routes that do non-trivial work but aren't crushing CPU. */
export const RATE_LIMIT_STANDARD: Omit<RateLimitOpts, "bucket"> = {
  limit: 60,
  windowSec: 60,
};

/** Loose cap suitable for read-mostly cached endpoints. */
export const RATE_LIMIT_LOOSE: Omit<RateLimitOpts, "bucket"> = {
  limit: 120,
  windowSec: 60,
};
