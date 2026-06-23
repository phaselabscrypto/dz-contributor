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

/** The sweep tag for an epoch under the current builder version. */
export function sweepTag(epoch: number): string {
  return `epoch-${epoch}:${CANONICAL_SWEEP_VERSION}`;
}
