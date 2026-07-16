import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of an `Authorization: Bearer <secret>` header against the
 * expected `CRON_SECRET`. Avoids leaking the secret via response-timing on the
 * first differing byte (`timingSafeEqual` requires equal-length buffers, so the
 * length check short-circuits unequal lengths — which reveals only length, not
 * content).
 */
export function bearerMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(header);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
