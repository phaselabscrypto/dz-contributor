/**
 * ⚠️ SCAFFOLDING — NOT LIVE
 *
 * On-chain topology fetcher. Returns the same `LiveTopology` shape the
 * malbeclabs HTTP source returns, so the rest of the app doesn't care
 * which source is active.
 *
 * Currently throws `OnchainNotConfigured` on every call because the
 * Metro / Device / Link / Contributor decoders in `decoders.ts` are
 * stubs. `isOnchainReady()` returns false unless both
 * `DZ_REGISTRY_PROGRAM_ID` and `ONCHAIN_ENABLED=1` are configured —
 * which they aren't in production today.
 *
 * The single live path through this module is `isOnchainReady()` — used
 * by `/api/onchain/topology` to return 503 cleanly. See
 * `lib/onchain/README.md` for the activation checklist.
 */

import type {
  LiveTopology,
  LiveMetro,
  LiveDevice,
  LiveLink,
  LiveContributor,
  LiveValidator,
} from "@/lib/types/live";
import {
  DZ_REGISTRY_PROGRAM_ID,
  ONCHAIN_ENABLED,
  ACCOUNT_DISCRIMINATORS,
} from "./program-ids";
import { getProgramAccounts } from "./client";
import {
  decodeContributor,
  decodeDevice,
  decodeLink,
  decodeMetro,
  dataToBuffer,
  OnchainNotConfigured,
} from "./decoders";

export function isOnchainReady(): boolean {
  return ONCHAIN_ENABLED && Boolean(DZ_REGISTRY_PROGRAM_ID);
}

interface FetchTopologyResult {
  topology: LiveTopology;
  source: "onchain";
}

/**
 * Fetch the full topology directly from chain.
 *
 * Pending DZ IDL — we filter `getProgramAccounts` by a discriminator memcmp
 * for each account type. Once the real IDL lands, the discriminators in
 * `program-ids.ts` swap to the real 8-byte anchor discriminators and the
 * decoders become real.
 */
export async function fetchOnchainTopology(): Promise<FetchTopologyResult> {
  if (!isOnchainReady()) {
    throw new OnchainNotConfigured("topology");
  }

  // Pull each account class in parallel.
  const [metroAccounts, deviceAccounts, linkAccounts, contributorAccounts] =
    await Promise.all([
      getProgramAccounts(DZ_REGISTRY_PROGRAM_ID, [
        { memcmp: { offset: 0, bytes: encodeDisc(ACCOUNT_DISCRIMINATORS.metro) } },
      ]),
      getProgramAccounts(DZ_REGISTRY_PROGRAM_ID, [
        { memcmp: { offset: 0, bytes: encodeDisc(ACCOUNT_DISCRIMINATORS.device) } },
      ]),
      getProgramAccounts(DZ_REGISTRY_PROGRAM_ID, [
        { memcmp: { offset: 0, bytes: encodeDisc(ACCOUNT_DISCRIMINATORS.link) } },
      ]),
      getProgramAccounts(DZ_REGISTRY_PROGRAM_ID, [
        {
          memcmp: {
            offset: 0,
            bytes: encodeDisc(ACCOUNT_DISCRIMINATORS.contributor),
          },
        },
      ]),
    ]);

  const metros: LiveMetro[] = metroAccounts.map(({ pubkey, account }) => {
    const decoded = decodeMetro(pubkey, dataToBuffer(account.data));
    return decoded;
  });

  const devices: LiveDevice[] = deviceAccounts.map(({ pubkey, account }) => {
    const d = decodeDevice(pubkey, dataToBuffer(account.data));
    // We need a metroCode join; the decoder will return metroPk → resolve via
    // the metro list above.
    const metro = metros.find((m) => m.pk === d.metroPk);
    return {
      pk: d.pk,
      code: d.code,
      status: d.status,
      deviceType: d.deviceType,
      metroPk: d.metroPk,
      metroCode: metro?.code ?? "",
      contributorPk: d.contributorPk,
      contributorCode: d.contributorCode,
      // Stake/user/validator counts are off-chain telemetry, set to zero;
      // higher layers can fill from /api/live/stats if needed.
      userCount: 0,
      validatorCount: 0,
      stakeSol: 0,
      stakeShare: 0,
    };
  });

  const links: LiveLink[] = linkAccounts.map(({ pubkey, account }) => {
    const l = decodeLink(pubkey, dataToBuffer(account.data));
    const sideADev = devices.find((d) => d.pk === l.sideAPk);
    const sideZDev = devices.find((d) => d.pk === l.sideZPk);
    return {
      pk: l.pk,
      code: l.code,
      status: l.status,
      linkType: l.linkType,
      bandwidthBps: l.bandwidthBps,
      sideAPk: l.sideAPk,
      sideACode: sideADev?.code ?? "",
      sideAMetro: sideADev?.metroCode ?? "",
      sideZPk: l.sideZPk,
      sideZCode: sideZDev?.code ?? "",
      sideZMetro: sideZDev?.metroCode ?? "",
      contributorPk: "",
      contributorCode: l.contributorCode,
      latencyUs: l.latencyUs,
      jitterUs: 0,
      lossPercent: 0,
      inBps: 0,
      outBps: 0,
      committedRttNs: 0,
    };
  });

  // Aggregate contributors from devices + links to mirror the malbec shape.
  const contributorMap = new Map<string, LiveContributor>();
  for (const ca of contributorAccounts) {
    const c = decodeContributor(ca.pubkey, dataToBuffer(ca.account.data));
    contributorMap.set(c.code, {
      code: c.code,
      pk: c.pk,
      deviceCount: 0,
      linkCount: 0,
      focusLinkCount: 0,
      totalStakeSol: 0,
      validatorCount: 0,
      totalBandwidthBps: 0,
      metros: [],
    });
  }
  for (const d of devices) {
    const c = contributorMap.get(d.contributorCode);
    if (c) {
      c.deviceCount++;
      if (d.metroCode && !c.metros.includes(d.metroCode)) {
        c.metros.push(d.metroCode);
      }
    }
  }
  const onchainDeviceContributor = new Map<string, string>();
  for (const d of devices) onchainDeviceContributor.set(d.pk, d.contributorCode);
  for (const l of links) {
    const c = contributorMap.get(l.contributorCode);
    if (c) {
      c.linkCount++;
      c.totalBandwidthBps += l.bandwidthBps;
    }
    // Either-endpoint attribution (mirrors live-topology-fetch + the service's
    // count_focus_links) — what gates the per-link breakdown.
    const endpoints = new Set<string>();
    const a = onchainDeviceContributor.get(l.sideAPk);
    const z = onchainDeviceContributor.get(l.sideZPk);
    if (a) endpoints.add(a);
    if (z) endpoints.add(z);
    for (const code of endpoints) {
      const ec = contributorMap.get(code);
      if (ec) ec.focusLinkCount++;
    }
  }

  // Validators are a separate concern (gossip-derived) — left empty here.
  const validators: LiveValidator[] = [];

  return {
    topology: {
      metros,
      devices,
      links,
      validators,
      contributors: Array.from(contributorMap.values()),
      fetchedAt: Date.now(),
    },
    source: "onchain",
  };
}

/**
 * Encode a 1-byte discriminator into a base58-encoded string the way the
 * Solana RPC `memcmp` filter expects. Once the real anchor 8-byte
 * discriminators are wired, swap this for a base58-encoder helper.
 */
function encodeDisc(byte: number): string {
  // Base58 of a single byte = the alphabet character at that index for
  // values < 58; for values >= 58 we fall back to a 2-char encoding.
  // For our placeholder discriminators (0x01..0x04) this is fine.
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (byte < ALPHABET.length) return ALPHABET[byte];
  // 2-byte representation for larger bytes.
  return ALPHABET[Math.floor(byte / ALPHABET.length)] + ALPHABET[byte % ALPHABET.length];
}
