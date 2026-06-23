import { NextResponse } from "next/server";
import type { Publisher, PublisherCheckResponse } from "@/lib/types/publisher";
import { LAMPORTS_PER_SOL } from "@/lib/constants/config";

/**
 * Publisher feed — combines DZ Foundation's canonical multicast validator
 * exports (per DZ Foundation guidance (2026-05-12)) with the malbec publisher-check
 * enrichment fields that the Foundation feeds don't carry.
 *
 * Source priority for each field:
 *   - `published_shreds` / publisher set membership: Foundation `latest.json`
 *   - `leader_slots`, `client_id`, `software_client`: Foundation
 *     `multicast_validator_leader_slots/{epoch}.json`
 *   - `publishing_retransmitted`, `validator_name`, `multicast_connected`,
 *     `validator_version`, `is_backup`: malbec `publisher-check` (best-effort)
 *
 * If the Foundation feeds are reachable we trust them as authoritative.
 * malbec is treated as an enrichment overlay, never a primary truth source.
 */

// The `mulitcast_validators` segment (sic — swapped i/t) matches Foundation's
// actual S3 export path. Do NOT "fix" the spelling here unless Foundation
// publishes the same data under the corrected path; if they ever rename, this
// fetch will start 404'ing and the publisher fallback chain will kick in.
const FOUNDATION_LATEST_URL =
  "https://doublezero-foundation-public.s3.us-east-2.amazonaws.com/exports/mulitcast_validators/latest.json";

// Per-epoch leader-slot feed. Note the path uses a non-padded epoch number.
const FOUNDATION_LEADER_SLOTS_URL = (epoch: number) =>
  `https://doublezero-foundation-public.s3.us-east-2.amazonaws.com/exports/multicast_validator_leader_slots/${epoch}.json`;

const MALBEC_PUBLISHER_URL = "https://data.malbeclabs.com/api/dz/publisher-check";

const CACHE_TTL = 5 * 60 * 1000;

interface CacheEntry {
  data: PublisherCheckResponse;
  ts: number;
}
let cache: CacheEntry | null = null;

interface FoundationMulticastRow {
  votekey: string;
  device: string;
  city: string;
  stake_sol: number;
  published_shreds: boolean;
}

interface FoundationLeaderSlotsRow {
  epoch: number;
  node_identity: string;
  client_id: number;
  software_client: string;
  number_of_leader_slots: number;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  // Fan-out the three feeds in parallel. Foundation is authoritative; malbec
  // is an optional enrichment overlay. We don't block on malbec.
  const [foundationLatest, malbec] = await Promise.all([
    fetchJson<FoundationMulticastRow[]>(FOUNDATION_LATEST_URL, 10_000),
    fetchJson<PublisherCheckResponse>(MALBEC_PUBLISHER_URL, 10_000),
  ]);

  // If Foundation is down AND malbec gave us nothing, fail visibly.
  if (!foundationLatest && !malbec) {
    return NextResponse.json(
      { error: "All publisher feeds unreachable (Foundation + malbec)" },
      { status: 502 },
    );
  }

  // Choose the current epoch to fetch leader slots for. Prefer malbec's
  // `epoch` since the latest.json export doesn't carry one.
  const epoch = malbec?.epoch ?? 0;
  const leaderSlots = epoch
    ? await fetchJson<FoundationLeaderSlotsRow[]>(
        FOUNDATION_LEADER_SLOTS_URL(epoch),
        10_000,
      )
    : null;

  // Build lookups from the auxiliary feeds.
  const malbecByVote = new Map<string, Publisher>();
  if (malbec) {
    for (const p of malbec.publishers) {
      malbecByVote.set(p.vote_pubkey, p);
    }
  }
  const leaderSlotsByNode = new Map<string, FoundationLeaderSlotsRow>();
  if (leaderSlots) {
    for (const r of leaderSlots) {
      leaderSlotsByNode.set(r.node_identity, r);
    }
  }

  let publishers: Publisher[];
  let totalNetworkStake: number;

  if (foundationLatest) {
    // Foundation is authoritative for the multicast set membership and the
    // `published_shreds` flag. We synthesize a `Publisher` row per Foundation
    // entry and enrich with malbec where the same votekey exists.
    publishers = foundationLatest.map((row) => {
      const m = malbecByVote.get(row.votekey);
      const lamports = Math.round(row.stake_sol * LAMPORTS_PER_SOL);
      const ls = m ? leaderSlotsByNode.get(m.node_pubkey) : undefined;
      return {
        publisher_ip: m?.publisher_ip ?? "",
        client_ip: m?.client_ip ?? "",
        node_pubkey: m?.node_pubkey ?? "",
        vote_pubkey: row.votekey,
        dz_user_pubkey: m?.dz_user_pubkey ?? "",
        dz_device_code: row.device,
        dz_metro_code: m?.dz_metro_code ?? row.city,
        activated_stake: lamports,
        // Foundation feed is the multicast set itself — every row is multicast.
        // Trust malbec when it disagrees because malbec measures live socket
        // state, but default to true when malbec is silent.
        multicast_connected: m?.multicast_connected ?? true,
        publishing_leader_shreds: row.published_shreds,
        // Foundation feed doesn't carry retransmit state — fall back to malbec
        // or assume "not publishing retransmits" (eligible) so we don't
        // silently strip everyone of rewards.
        publishing_retransmitted: m?.publishing_retransmitted ?? false,
        leader_slots: ls?.number_of_leader_slots ?? m?.leader_slots ?? 0,
        total_slots: m?.total_slots ?? 0,
        total_unique_shreds: m?.total_unique_shreds ?? 0,
        slots_needing_repair: m?.slots_needing_repair ?? 0,
        validator_client: ls?.software_client ?? m?.validator_client ?? "",
        validator_version: m?.validator_version ?? "",
        validator_name: m?.validator_name ?? "",
        validator_version_ok: m?.validator_version_ok ?? true,
        is_backup: m?.is_backup ?? false,
      };
    });
    // Foundation doesn't ship total_network_stake. Fall back to malbec.
    totalNetworkStake = malbec?.total_network_stake ?? 0;
  } else if (malbec) {
    // Foundation unreachable — fall back to the malbec-only pipeline.
    publishers = malbec.publishers;
    totalNetworkStake = malbec.total_network_stake;
  } else {
    // Already returned 502 above; this is unreachable but keeps types tidy.
    publishers = [];
    totalNetworkStake = 0;
  }

  const data: PublisherCheckResponse = {
    epoch,
    total_network_stake: totalNetworkStake,
    publishers,
  };
  cache = { data, ts: Date.now() };
  return NextResponse.json(data);
}
