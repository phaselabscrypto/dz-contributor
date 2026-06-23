import { NextResponse } from "next/server";
import type { LiveStats } from "@/lib/types/live";
import { reportError } from "@/lib/observability";

export const revalidate = 60;

const UPSTREAM = "https://data.malbeclabs.com/api/stats";
let cache: { data: LiveStats; ts: number } | null = null;
const TTL_MS = 60_000;

interface RawStats {
  validators_on_dz?: number;
  total_stake_sol?: number;
  stake_share_pct?: number;
  users?: number;
  devices?: number;
  links?: number;
  contributors?: number;
  metros?: number;
  bandwidth_bps?: number;
  user_inbound_bps?: number;
  fetched_at?: string;
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) {
    return NextResponse.json(cache.data);
  }
  try {
    const res = await fetch(UPSTREAM, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream ${res.status}` },
        { status: res.status },
      );
    }
    const raw: RawStats = await res.json();
    const data: LiveStats = {
      validatorsOnDz: raw.validators_on_dz ?? 0,
      totalStakeSol: raw.total_stake_sol ?? 0,
      stakeSharePct: raw.stake_share_pct ?? 0,
      users: raw.users ?? 0,
      devices: raw.devices ?? 0,
      links: raw.links ?? 0,
      contributors: raw.contributors ?? 0,
      metros: raw.metros ?? 0,
      bandwidthBps: raw.bandwidth_bps ?? 0,
      userInboundBps: raw.user_inbound_bps ?? 0,
      fetchedAt: raw.fetched_at ?? new Date().toISOString(),
    };
    cache = { data, ts: now };
    return NextResponse.json(data);
  } catch (err) {
    reportError(err, { source: "api/live/stats" });
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Stats fetch failed: ${msg}` },
      { status: 502 },
    );
  }
}
