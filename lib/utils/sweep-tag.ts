import { CANONICAL_SHAPLEY_PARAMS } from "@/lib/constants/config";

/**
 * Tag identifying one epoch's canonical link-value sweep — the key of the
 * Rust service's "fully swept" S3 marker (`GET
 * /precompute/link-estimates/status?tag=…`). The cron route checks the marker
 * FIRST and skips the 70MB snapshot fetch + canonical build when the epoch is
 * already swept, so the tag must be computable WITHOUT the snapshot.
 *
 * BUMP `CANONICAL_SWEEP_VERSION` whenever the canonical input builder
 * (`lib/utils/canonical-input-builder.ts`) or solver-facing parameters change
 * in a way that alters built inputs: the per-operator S3 results are keyed by
 * payload hash and would naturally miss, but a stale marker would stop the
 * cron from ever re-sweeping the epoch under the new inputs. Epochs themselves
 * are immutable, so a marker for a given (epoch, version) never goes stale.
 */
export const CANONICAL_SWEEP_VERSION = "canonical-v1";

/**
 * FNV-1a over a string, as 8 lowercase hex digits.
 *
 * Deliberately dependency-free and pure JS rather than `node:crypto`, so this
 * module stays safe to import from anywhere. The service treats the tag as an
 * opaque string, so the only requirement is determinism.
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Fingerprint of the OFFCHAIN parameters that shape the canonical input.
 *
 * These are env-overridable (`DZ_IBRL_PRIORITY`, `DZ_PUBLIC_LATENCY_MULTIPLIER`)
 * and DZ has changed them once already, in PR #369. Any change alters every
 * built input.
 */
export function canonicalParamsFingerprint(): string {
  const params = CANONICAL_SHAPLEY_PARAMS;
  // Keys listed explicitly, so adding a param is a deliberate decision about
  // whether it belongs in the fingerprint rather than a silent rotation.
  return fnv1a(
    `ibrl=${params.ibrlPriority};plm=${params.publicLatencyMultiplier}`,
  );
}

/**
 * The sweep tag for an epoch: `epoch-211:canonical-v1:1a2b3c4d`.
 *
 * The trailing fingerprint is load-bearing, not decoration. The tag keys the
 * `(tag, operator)` alias that lets `/link-value` serve a cached link estimate
 * WITHOUT rebuilding the canonical input. Rebuilding used to be the thing that
 * caught a parameter change: a different input hashes differently, misses, and
 * recomputes. An epoch-only tag would throw that guard away and keep serving
 * pre-change values under post-change parameters.
 *
 * Rotating this also rotates the sweep marker, which is what makes each epoch
 * re-sweep exactly once after a parameter change. That pass is cheap: results
 * are keyed by payload hash, which is unchanged for an unchanged input, so
 * every operator hits the S3 cache and the pass only writes aliases.
 */
export function sweepTag(epoch: number): string {
  return `epoch-${epoch}:${CANONICAL_SWEEP_VERSION}:${canonicalParamsFingerprint()}`;
}
