import type { LiveTopology } from "@/lib/types/live";

/**
 * Topology METADATA for one of a contributor's links — naming, endpoints, and
 * physical specs only.
 *
 * There is deliberately NO value/percent/tier here: per-link VALUE comes
 * exclusively from the canonical Rust solver (per-link retag-Shapley, served
 * from the epoch precompute cache or computed by a job — see
 * `lib/hooks/use-link-estimate.ts`). If canonical values are unavailable, the
 * UI must say so — never substitute.
 */
export interface LinkMetaRow {
  linkPk: string;
  code: string;
  sideAMetro: string;
  sideZMetro: string;
  bandwidthBps: number;
  latencyUs: number;
  status: string;
}

/** A contributor's links from the live topology, as display metadata. */
export function linkMetaRows(
  topology: LiveTopology,
  contributorCode: string,
): LinkMetaRow[] {
  return topology.links
    .filter((l) => l.contributorCode === contributorCode)
    .map((l) => ({
      linkPk: l.pk,
      code: l.code,
      sideAMetro: l.sideAMetro,
      sideZMetro: l.sideZMetro,
      bandwidthBps: l.bandwidthBps,
      latencyUs: l.latencyUs,
      status: l.status,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
