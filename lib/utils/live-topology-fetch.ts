/**
 * Shared live-topology fetch + parse.
 *
 * Server code imports this helper directly instead of self-calling
 * `/api/live/topology` over HTTP (a cold-start deadlock risk on Vercel
 * — see epoch-discovery.ts). The route exists only to expose the
 * result over HTTP for client-side consumers.
 */

import type { LiveTopology, LiveContributor } from "@/lib/types/live";

const UPSTREAM = "https://data.malbeclabs.com/api/topology";
const TTL_MS = 60_000;

interface RawMetro {
  pk: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
}
interface RawDevice {
  pk: string;
  code: string;
  status: string;
  device_type: string;
  metro_pk: string;
  contributor_pk: string;
  contributor_code: string;
  user_count: number;
  validator_count: number;
  stake_sol: number;
  stake_share: number;
}
interface RawLink {
  pk: string;
  code: string;
  status: string;
  link_type: string;
  bandwidth_bps: number;
  side_a_pk: string;
  side_a_code: string;
  side_z_pk: string;
  side_z_code: string;
  contributor_pk: string;
  contributor_code: string;
  latency_us: number;
  jitter_us: number;
  loss_percent: number;
  in_bps: number;
  out_bps: number;
  committed_rtt_ns: number;
}
interface RawValidator {
  vote_pubkey: string;
  node_pubkey: string;
  device_pk: string;
  latitude: number;
  longitude: number;
  city: string;
  country: string;
  stake_sol: number;
  stake_share: number;
  commission: number;
  version: string;
}
interface RawTopology {
  metros: RawMetro[];
  devices: RawDevice[];
  links: RawLink[];
  validators: RawValidator[];
}

let cache: { data: LiveTopology; ts: number } | null = null;

/**
 * Fetch + parse the malbec topology feed with a 60-second module-level
 * cache. Throws on upstream failure; callers decide how to surface it
 * (the route returns 502; the baseline shapley route uses the TS
 * fallback solver against an empty input).
 */
export async function fetchLiveTopology(): Promise<LiveTopology> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) {
    return cache.data;
  }

  const res = await fetch(UPSTREAM, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`malbec topology HTTP ${res.status}`);
  }
  const raw: RawTopology = await res.json();

  const metroByPk = new Map<string, RawMetro>();
  for (const m of raw.metros) metroByPk.set(m.pk, m);
  const deviceMetroCode = new Map<string, string>();
  for (const d of raw.devices) {
    deviceMetroCode.set(d.pk, metroByPk.get(d.metro_pk)?.code ?? "");
  }

  const cmap = new Map<string, LiveContributor>();
  for (const d of raw.devices) {
    const c =
      cmap.get(d.contributor_code) ??
      ({
        code: d.contributor_code,
        pk: d.contributor_pk,
        deviceCount: 0,
        linkCount: 0,
        totalStakeSol: 0,
        validatorCount: 0,
        totalBandwidthBps: 0,
        metros: [],
      } satisfies LiveContributor);
    c.deviceCount++;
    c.totalStakeSol += d.stake_sol || 0;
    c.validatorCount += d.validator_count || 0;
    const mc = metroByPk.get(d.metro_pk)?.code;
    if (mc && !c.metros.includes(mc)) c.metros.push(mc);
    cmap.set(d.contributor_code, c);
  }
  for (const l of raw.links) {
    const c = cmap.get(l.contributor_code);
    if (c) {
      c.linkCount++;
      c.totalBandwidthBps += l.bandwidth_bps || 0;
    }
  }

  const data: LiveTopology = {
    metros: raw.metros.map((m) => ({
      pk: m.pk,
      code: m.code,
      name: m.name,
      latitude: m.latitude,
      longitude: m.longitude,
    })),
    devices: raw.devices.map((d) => ({
      pk: d.pk,
      code: d.code,
      status: d.status,
      deviceType: d.device_type,
      metroPk: d.metro_pk,
      metroCode: metroByPk.get(d.metro_pk)?.code ?? "",
      contributorPk: d.contributor_pk,
      contributorCode: d.contributor_code,
      userCount: d.user_count ?? 0,
      validatorCount: d.validator_count ?? 0,
      stakeSol: d.stake_sol ?? 0,
      stakeShare: d.stake_share ?? 0,
    })),
    links: raw.links.map((l) => ({
      pk: l.pk,
      code: l.code,
      status: l.status,
      linkType: l.link_type,
      bandwidthBps: l.bandwidth_bps ?? 0,
      sideAPk: l.side_a_pk,
      sideACode: l.side_a_code,
      sideAMetro: deviceMetroCode.get(l.side_a_pk) ?? "",
      sideZPk: l.side_z_pk,
      sideZCode: l.side_z_code,
      sideZMetro: deviceMetroCode.get(l.side_z_pk) ?? "",
      contributorPk: l.contributor_pk,
      contributorCode: l.contributor_code,
      latencyUs: l.latency_us ?? 0,
      jitterUs: l.jitter_us ?? 0,
      lossPercent: l.loss_percent ?? 0,
      inBps: l.in_bps ?? 0,
      outBps: l.out_bps ?? 0,
      committedRttNs: l.committed_rtt_ns ?? 0,
    })),
    validators: (raw.validators || []).map((v) => ({
      votePubkey: v.vote_pubkey,
      nodePubkey: v.node_pubkey,
      devicePk: v.device_pk,
      latitude: v.latitude,
      longitude: v.longitude,
      city: v.city,
      country: v.country,
      stakeSol: v.stake_sol ?? 0,
      stakeShare: v.stake_share ?? 0,
      commission: v.commission ?? 0,
      version: v.version ?? "",
    })),
    contributors: Array.from(cmap.values()).sort(
      (a, b) => b.linkCount - a.linkCount,
    ),
    fetchedAt: now,
  };

  cache = { data, ts: now };
  return data;
}
