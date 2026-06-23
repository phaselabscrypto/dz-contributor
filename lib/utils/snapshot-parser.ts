import type { RawSnapshot } from "@/lib/types/snapshot";
import type {
  Contributor,
  Device,
  Link,
  LinkEndpoint,
  Location,
  Exchange,
  CityDemand,
  ParsedSnapshot,
} from "@/lib/types/contributor";

/**
 * Sentinel demand score for a location that has validators but zero
 * outbound links — effectively infinite per-link demand. The value is
 * large enough to sort above any realistic computed demand, but small
 * enough that downstream summation/multiplication won't overflow.
 *
 * Why 999 (not Infinity): the chart components and CSV exports treat
 * the score as a finite number; `Infinity` would serialise to `null`
 * in JSON and break ordering.
 */
const UNSERVED_LOCATION_DEMAND_SCORE = 999;

export function parseSnapshot(raw: RawSnapshot): ParsedSnapshot {
  const svc = raw.fetch_data.dz_serviceability;
  const scheduleMap = raw.leader_schedule?.schedule_map || {};

  // Build location lookup: pubkey → Location
  const locationMap = new Map<string, Location>();
  for (const [pk, loc] of Object.entries(svc.locations)) {
    locationMap.set(pk, {
      pubkey: pk,
      code: loc.code,
      name: loc.name,
      country: loc.country,
      lat: loc.lat,
      lng: loc.lng,
    });
  }

  // Build exchange lookup: pubkey → Exchange
  const exchangeMap = new Map<string, Exchange>();
  for (const [pk, ex] of Object.entries(svc.exchanges)) {
    exchangeMap.set(pk, {
      pubkey: pk,
      code: ex.code,
      name: ex.name,
      lat: ex.lat,
      lng: ex.lng,
      devicePairs: 0,
    });
  }

  // Build contributor pubkey → code lookup
  const contributorCodeMap = new Map<string, string>();
  for (const [pk, c] of Object.entries(svc.contributors)) {
    contributorCodeMap.set(pk, c.code);
  }

  // Parse devices: pubkey → Device
  const deviceMap = new Map<string, Device>();
  const devicesByContributor = new Map<string, Device[]>();

  for (const [pk, d] of Object.entries(svc.devices)) {
    const loc = locationMap.get(d.location_pk);
    const ex = exchangeMap.get(d.exchange_pk);
    const contribCode = contributorCodeMap.get(d.contributor_pk) || "unknown";

    const device: Device = {
      pubkey: pk,
      locationCode: loc?.code || "",
      locationName: loc?.name || "",
      exchangeCode: ex?.code || "",
      exchangeName: ex?.name || "",
      deviceType: d.device_type,
      contributorCode: contribCode,
      health: d.device_health || d.status,
      maxUsers: d.max_users,
    };

    deviceMap.set(pk, device);

    const arr = devicesByContributor.get(contribCode) || [];
    arr.push(device);
    devicesByContributor.set(contribCode, arr);
  }

  // Parse links
  const linksByContributor = new Map<string, Link[]>();
  const linksPerLocation = new Map<string, number>();

  for (const [pk, l] of Object.entries(svc.links)) {
    const deviceA = deviceMap.get(l.side_a_pk);
    const deviceB = deviceMap.get(l.side_z_pk);
    const contribCode = contributorCodeMap.get(l.contributor_pk) || "unknown";

    const makeEndpoint = (dev: Device | undefined, devicePk: string): LinkEndpoint => {
      if (!dev) {
        return {
          devicePubkey: devicePk,
          locationCode: "",
          locationName: "",
          city: "",
          country: "",
          lat: 0,
          lng: 0,
        };
      }
      // Find the location by code
      const loc = Array.from(locationMap.values()).find(
        (lo) => lo.code === dev.locationCode
      );
      return {
        devicePubkey: devicePk,
        locationCode: dev.locationCode,
        locationName: dev.locationName,
        city: dev.locationName,
        country: loc?.country || "",
        lat: loc?.lat || 0,
        lng: loc?.lng || 0,
      };
    };

    const link: Link = {
      pubkey: pk,
      sideA: makeEndpoint(deviceA, l.side_a_pk),
      sideZ: makeEndpoint(deviceB, l.side_z_pk),
      linkType: l.link_type,
      bandwidthGbps: l.bandwidth / 1_000_000_000,
      delayMs: l.delay_ns / 1_000_000,
      jitterMs: l.jitter_ns / 1_000_000,
      contributorCode: contribCode,
      health: l.link_health || l.status,
    };

    const arr = linksByContributor.get(contribCode) || [];
    arr.push(link);
    linksByContributor.set(contribCode, arr);

    // Track links per location (both endpoints)
    if (deviceA?.locationCode) {
      linksPerLocation.set(
        deviceA.locationCode,
        (linksPerLocation.get(deviceA.locationCode) || 0) + 1
      );
    }
    if (deviceB?.locationCode) {
      linksPerLocation.set(
        deviceB.locationCode,
        (linksPerLocation.get(deviceB.locationCode) || 0) + 1
      );
    }
  }

  // Map users (validators) to locations via their devices
  const usersPerLocation = new Map<string, Set<string>>();
  const userSlots = new Map<string, number>();

  for (const [userPk, user] of Object.entries(svc.users)) {
    const device = deviceMap.get(user.device_pk);
    if (!device) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[snapshot-parser] User ${userPk}: device ${user.device_pk} not found, skipping`);
      }
      continue;
    }
    if (!user.validator_pubkey) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[snapshot-parser] User ${userPk}: missing validator_pubkey, skipping`);
      }
      continue;
    }
    if (user.validator_pubkey !== "11111111111111111111111111111111") {
      const locUsers = usersPerLocation.get(device.locationCode) || new Set();
      locUsers.add(user.validator_pubkey);
      usersPerLocation.set(device.locationCode, locUsers);
    }
    const slots = scheduleMap[user.validator_pubkey] || 0;
    if (slots > 0) {
      userSlots.set(user.validator_pubkey, slots);
    }
  }

  // Compute totals
  const totalSlots = Object.values(scheduleMap).reduce(
    (a, b) => a + b,
    0
  );
  const totalValidators = Object.keys(scheduleMap).length;

  // Compute city demands
  const cityDemands: CityDemand[] = [];
  for (const loc of locationMap.values()) {
    const validators = usersPerLocation.get(loc.code);
    const validatorCount = validators?.size || 0;
    let locationSlots = 0;
    if (validators) {
      for (const v of validators) {
        locationSlots += userSlots.get(v) || 0;
      }
    }
    const linkCount = linksPerLocation.get(loc.code) || 0;
    const demandScore =
      linkCount > 0
        ? (locationSlots / Math.max(totalSlots, 1)) / linkCount
        : locationSlots > 0
        ? UNSERVED_LOCATION_DEMAND_SCORE
        : 0;

    cityDemands.push({
      locationCode: loc.code,
      locationName: loc.name,
      country: loc.country,
      validatorCount,
      totalSlots: locationSlots,
      linkCount,
      demandScore,
    });
  }

  cityDemands.sort((a, b) => b.demandScore - a.demandScore);

  // Build contributors
  const contributors: Contributor[] = Object.entries(svc.contributors).map(
    ([pk, c]) => {
      const devices = devicesByContributor.get(c.code) || [];
      const links = linksByContributor.get(c.code) || [];
      const citySet = new Set<string>();
      for (const d of devices) {
        if (d.locationName) citySet.add(d.locationName);
      }

      return {
        code: c.code,
        pubkey: pk,
        status: c.status,
        deviceCount: devices.length,
        linkCount: links.length,
        cities: Array.from(citySet),
        devices,
        links,
        linearShare: 0,
      };
    }
  );

  // Compute linear-heuristic reward shares (NOT canonical Shapley —
  // see Contributor.linearShare doc).
  computeLinearShares(contributors, cityDemands);

  return {
    dzEpoch: raw.dz_epoch,
    solanaEpoch: raw.solana_epoch,
    contributors,
    locations: Array.from(locationMap.values()),
    exchanges: Array.from(exchangeMap.values()),
    cityDemands,
    totalSlots,
    totalValidators,
    version: raw.metadata?.network || "",
    timestamp: raw.metadata?.created_at || "",
  };
}

/**
 * Linear-heuristic reward share. NOT canonical Shapley — each contributor's
 * value is the sum of demand scores at the endpoints of their links, then
 * normalized. Used as a directional fallback when the LP solver is offline.
 * Canonical values come from the Rust Shapley service via `/api/shapley`.
 */
function computeLinearShares(
  contributors: Contributor[],
  cityDemands: CityDemand[]
) {
  const demandMap = new Map<string, number>();
  for (const cd of cityDemands) {
    demandMap.set(cd.locationCode, cd.demandScore);
  }

  let totalValue = 0;
  const contributorValues: number[] = [];

  for (const contrib of contributors) {
    let value = 0;
    for (const link of contrib.links) {
      const demandA = demandMap.get(link.sideA.locationCode) || 0;
      const demandZ = demandMap.get(link.sideZ.locationCode) || 0;
      value += (demandA + demandZ) / 2;
    }
    contributorValues.push(value);
    totalValue += value;
  }

  for (let i = 0; i < contributors.length; i++) {
    contributors[i].linearShare =
      totalValue > 0 ? contributorValues[i] / totalValue : 0;
  }
}
