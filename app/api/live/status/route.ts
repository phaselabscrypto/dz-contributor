import { NextResponse } from "next/server";
import type { LiveStatus, LiveLinkIssue, LiveTopUtilLink } from "@/lib/types/live";
import { reportError } from "@/lib/observability";

export const revalidate = 60;

const UPSTREAM = "https://data.malbeclabs.com/api/status";
let cache: { data: LiveStatus; ts: number } | null = null;
const TTL_MS = 60_000;

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
    const raw = (await res.json()) as Record<string, unknown>;
    const network = (raw.network as Record<string, number>) ?? {};
    const links = (raw.links as Record<string, unknown>) ?? {};

    const issues: LiveLinkIssue[] = (
      (links.issues as Record<string, unknown>[] | undefined) ?? []
    ).map((i) => ({
      code: String(i.code ?? ""),
      linkType: String(i.link_type ?? ""),
      contributor: String(i.contributor ?? ""),
      issue: String(i.issue ?? ""),
      value: Number(i.value ?? 0),
      threshold: Number(i.threshold ?? 0),
      sideAMetro: String(i.side_a_metro ?? ""),
      sideZMetro: String(i.side_z_metro ?? ""),
      since: String(i.since ?? ""),
      isDown: Boolean(i.is_down),
      bandwidthBps: Number(i.bandwidth_bps ?? 0),
    }));

    const topUtilLinks: LiveTopUtilLink[] = (
      (links.top_util_links as Record<string, unknown>[] | undefined) ?? []
    )
      .slice(0, 10)
      .map((l) => ({
        pk: String(l.pk ?? ""),
        code: String(l.code ?? ""),
        linkType: String(l.link_type ?? ""),
        contributor: String(l.contributor ?? ""),
        bandwidthBps: Number(l.bandwidth_bps ?? 0),
        inBps: Number(l.in_bps ?? 0),
        outBps: Number(l.out_bps ?? 0),
        utilizationIn: Number(l.utilization_in ?? 0),
        utilizationOut: Number(l.utilization_out ?? 0),
        sideAMetro: String(l.side_a_metro ?? ""),
        sideZMetro: String(l.side_z_metro ?? ""),
      }));

    const data: LiveStatus = {
      status: String(raw.status ?? "unknown"),
      timestamp: String(raw.timestamp ?? new Date().toISOString()),
      network: {
        validatorsOnDz: Number(network.validators_on_dz ?? 0),
        totalStakeSol: Number(network.total_stake_sol ?? 0),
        stakeSharePct: Number(network.stake_share_pct ?? 0),
        users: Number(network.users ?? 0),
        devices: Number(network.devices ?? 0),
        links: Number(network.links ?? 0),
        contributors: Number(network.contributors ?? 0),
        metros: Number(network.metros ?? 0),
        bandwidthBps: Number(network.bandwidth_bps ?? 0),
        userInboundBps: Number(network.user_inbound_bps ?? 0),
        fetchedAt: new Date().toISOString(),
      },
      linkHealth: {
        total: Number(links.total ?? 0),
        healthy: Number(links.healthy ?? 0),
        degraded: Number(links.degraded ?? 0),
        unhealthy: Number(links.unhealthy ?? 0),
        disabled: Number(links.disabled ?? 0),
      },
      issues,
      topUtilLinks,
    };
    cache = { data, ts: now };
    return NextResponse.json(data);
  } catch (err) {
    reportError(err, { source: "api/live/status" });
    // Generic to the client — the message can name the upstream host.
    return NextResponse.json(
      { error: "Status fetch failed" },
      { status: 502 },
    );
  }
}
