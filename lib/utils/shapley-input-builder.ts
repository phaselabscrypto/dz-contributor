import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ParsedSnapshot, CityDemand } from "@/lib/types/contributor";
import type {
  ShapleyInput,
  ShapleyDevice,
  ShapleyPrivateLink,
  ShapleyPublicLink,
  ShapleyDemand,
} from "@/lib/types/shapley";
import { SHAPLEY_PARAMS } from "@/lib/constants/config";

function devWarn(msg: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(msg);
  }
}

/**
 * Strip trailing digits from a device name to recover the metro code.
 * E.g., `FRA1` → `FRA`, `CHI12` → `CHI`, `FRA` → `FRA`.
 */
export function metroFromDevice(deviceName: string): string {
  return deviceName.replace(/\d+$/, "");
}

// --- Metro code mapping ---
// Location codes (e.g., "DRT-ORD13") and exchange codes (e.g., "chi") use
// different naming. We build a mapping from location city name to exchange
// metro code (uppercased) so everything uses the same namespace.

export function buildCityNameToMetro(
  raw: RawSnapshot
): Map<string, string> {
  const svc = raw.fetch_data.dz_serviceability;
  const map = new Map<string, string>();

  // Exchange name → exchange code (uppercased)
  // e.g., "Frankfurt" → "FRA", "Chicago" → "CHI"
  for (const ex of Object.values(svc.exchanges)) {
    map.set(ex.name.toLowerCase(), ex.code.toUpperCase());
  }

  return map;
}

export function buildLocationCodeToMetro(
  raw: RawSnapshot,
  cityNameToMetro: Map<string, string>
): Map<string, string> {
  const svc = raw.fetch_data.dz_serviceability;
  const map = new Map<string, string>();

  for (const loc of Object.values(svc.locations)) {
    const metro = cityNameToMetro.get(loc.name.toLowerCase());
    if (metro) {
      map.set(loc.code, metro);
    }
  }

  return map;
}

// --- Aggregate city demands by metro ---

interface MetroAggregate {
  metro: string;
  validatorCount: number;
  totalSlots: number;
  userCount: number;
}

function aggregateByMetro(
  cityDemands: CityDemand[],
  usersPerLocation: Map<string, Set<string>>,
  locToMetro: Map<string, string>
): MetroAggregate[] {
  const map = new Map<string, MetroAggregate>();
  for (const cd of cityDemands) {
    const metro = locToMetro.get(cd.locationCode);
    if (!metro) {
      devWarn(`[shapley-input] aggregateByMetro: no metro mapping for location ${cd.locationCode} (${cd.locationName}), skipping`);
      continue;
    }
    const existing = map.get(metro) || {
      metro,
      validatorCount: 0,
      totalSlots: 0,
      userCount: 0,
    };
    existing.validatorCount += cd.validatorCount;
    existing.totalSlots += cd.totalSlots;
    existing.userCount += usersPerLocation.get(cd.locationCode)?.size || 0;
    map.set(metro, existing);
  }
  return Array.from(map.values());
}

// --- Build ShapleyInput sections ---

/**
 * Build the devices list using unique per-operator names in the format
 * `{metro}{N}` where N is a 1-based sequential counter per metro.
 * Returns both the devices array and a mapping from
 * `{metro}:{operatorCode}` → device name (e.g., `FRA:opA` → `FRA1`).
 */
function buildDevices(
  parsed: ParsedSnapshot,
  usersPerLocation: Map<string, Set<string>>,
  locToMetro: Map<string, string>
): { devices: ShapleyDevice[]; deviceNameMap: Map<string, string> } {
  const seen = new Set<string>();
  const devices: ShapleyDevice[] = [];
  const deviceNameMap = new Map<string, string>();
  // Track the next available number per metro (across all operators)
  const metroCounter = new Map<string, number>();

  for (const contrib of parsed.contributors) {
    for (const device of contrib.devices) {
      const metro = locToMetro.get(device.locationCode);
      if (!metro) {
        devWarn(`[shapley-input] buildDevices: no metro mapping for device location ${device.locationCode} (contributor: ${contrib.code}), skipping`);
        continue;
      }

      const key = `${metro}:${contrib.code}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const n = (metroCounter.get(metro) ?? 0) + 1;
      metroCounter.set(metro, n);
      const deviceName = `${metro}${n}`;
      deviceNameMap.set(key, deviceName);

      // The upstream LP solver uses `edge` as on-ramp/off-ramp bandwidth
      // (Mbps). The canonical builder computes it from interface bandwidth;
      // the heuristic builder doesn't have that data, so we use the same
      // 10 Gbps (10_000 Mbps) fallback that the canonical builder uses.
      const FALLBACK_EDGE_MBPS = 10_000;
      devices.push({
        device: deviceName,
        edge: FALLBACK_EDGE_MBPS,
        operator: contrib.code,
      });
    }
  }
  return { devices, deviceNameMap };
}

function buildPrivateLinks(
  parsed: ParsedSnapshot,
  locToMetro: Map<string, string>,
  deviceNameMap: Map<string, string>
): ShapleyPrivateLink[] {
  const links: ShapleyPrivateLink[] = [];
  for (const contrib of parsed.contributors) {
    for (const link of contrib.links) {
      const metro1 = locToMetro.get(link.sideA.locationCode);
      const metro2 = locToMetro.get(link.sideZ.locationCode);
      if (!metro1 || !metro2) {
        devWarn(`[shapley-input] buildPrivateLinks: metro lookup failed for link ${link.pubkey} (${link.sideA.locationCode}→${link.sideZ.locationCode}, contributor: ${contrib.code}), skipping`);
        continue;
      }

      const device1 = deviceNameMap.get(`${metro1}:${contrib.code}`);
      const device2 = deviceNameMap.get(`${metro2}:${contrib.code}`);
      if (!device1 || !device2) {
        devWarn(`[shapley-input] buildPrivateLinks: device name lookup failed for link ${link.pubkey} (${metro1}/${metro2}, contributor: ${contrib.code}), skipping`);
        continue;
      }

      links.push({
        device1,
        device2,
        latency: link.delayMs,
        bandwidth: link.bandwidthGbps,
        uptime: link.health === "Healthy" ? 0.99 : 0.9,
        shared: null,
      });
    }
  }
  return links;
}

function buildPublicLinks(raw: RawSnapshot): ShapleyPublicLink[] {
  const svc = raw.fetch_data.dz_serviceability;
  const samples = raw.fetch_data.dz_internet.internet_latency_samples;
  if (!samples) return [];

  // Exchange pubkey → metro code (uppercased exchange code)
  const exchangeToMetro = new Map<string, string>();
  for (const [pk, ex] of Object.entries(svc.exchanges)) {
    exchangeToMetro.set(pk, ex.code.toUpperCase());
  }

  // Aggregate latency samples by metro pair
  const linkMap = new Map<string, number[]>();
  for (const sample of samples) {
    const metro1 = exchangeToMetro.get(sample.origin_exchange_pk);
    const metro2 = exchangeToMetro.get(sample.target_exchange_pk);
    if (!metro1 || !metro2) {
      devWarn(`[shapley-input] buildPublicLinks: exchange lookup failed for latency sample (origin: ${sample.origin_exchange_pk}, target: ${sample.target_exchange_pk}), skipping`);
      continue;
    }
    if (metro1 === metro2) continue;

    const key = [metro1, metro2].sort().join("-");
    const latencies = linkMap.get(key) || [];

    if (sample.samples && sample.samples.length > 0) {
      const sorted = [...sample.samples].sort((a, b) => a - b);
      const medianUs = sorted[Math.floor(sorted.length / 2)];
      latencies.push(medianUs / 1000); // microseconds → milliseconds
    }
    linkMap.set(key, latencies);
  }

  const publicLinks: ShapleyPublicLink[] = [];
  for (const [key, latencies] of linkMap) {
    if (latencies.length === 0) continue;
    const [city1, city2] = key.split("-");
    publicLinks.push({ city1, city2, latency: Math.min(...latencies) });
  }

  return publicLinks;
}

function buildDemands(
  cityDemands: CityDemand[],
  totalSlots: number,
  usersPerLocation: Map<string, Set<string>>,
  locToMetro: Map<string, string>
): ShapleyDemand[] {
  const demands: ShapleyDemand[] = [];

  const metroStakes = aggregateByMetro(cityDemands, usersPerLocation, locToMetro);
  const sorted = [...metroStakes]
    .filter((m) => m.totalSlots > 0)
    .sort((a, b) => b.totalSlots - a.totalSlots);

  if (sorted.length === 0) return demands;

  const leader = sorted[0];
  const topMetros = sorted.slice(0, 10);

  // 1. Block propagation (multicast): leader broadcasts to all other top metros
  for (const metro of topMetros) {
    if (metro.metro === leader.metro) continue;
    demands.push({
      start: leader.metro,
      end: metro.metro,
      receivers: metro.validatorCount,
      traffic: 0.1,
      priority: totalSlots > 0 ? metro.totalSlots / totalSlots : 0,
      type: 1,
      multicast: true,
    });
  }

  // 2. RPC/user traffic (unicast): each non-leader metro sends to leader
  let typeId = 2;
  for (const metro of topMetros) {
    if (metro.metro === leader.metro) continue;
    const traffic = Math.min(10, Math.max(1, metro.userCount / 10));
    demands.push({
      start: metro.metro,
      end: leader.metro,
      receivers: 1,
      traffic,
      priority: 1.0,
      type: typeId++,
      multicast: false,
    });
  }

  return demands;
}

// --- Main builder ---

/**
 * Build the ShapleyInput and return both the input and the device name
 * mapping (`{metro}:{operatorCode}` → device name, e.g. `FRA:opA` → `FRA1`).
 * The map is needed by the modifier for simulation.
 */
export function buildShapleyInputWithMap(
  raw: RawSnapshot,
  parsed: ParsedSnapshot
): { input: ShapleyInput; deviceNameMap: Map<string, string> } {
  const svc = raw.fetch_data.dz_serviceability;

  // Build metro code mappings
  const cityNameToMetro = buildCityNameToMetro(raw);
  const locToMetro = buildLocationCodeToMetro(raw, cityNameToMetro);

  // Build users-per-location map
  const usersPerLocation = new Map<string, Set<string>>();
  for (const [userPk, user] of Object.entries(svc.users)) {
    if (
      !user.validator_pubkey ||
      user.validator_pubkey === "11111111111111111111111111111111"
    )
      continue;

    const device = svc.devices[user.device_pk];
    if (!device) {
      devWarn(`[shapley-input] buildShapleyInput: user ${userPk} references missing device ${user.device_pk}, skipping`);
      continue;
    }

    const loc = Object.entries(svc.locations).find(
      ([pk]) => pk === device.location_pk
    );
    if (!loc) {
      devWarn(`[shapley-input] buildShapleyInput: device ${user.device_pk} references missing location ${device.location_pk}, skipping`);
      continue;
    }

    const locCode = loc[1].code;
    const locUsers = usersPerLocation.get(locCode) || new Set();
    locUsers.add(user.validator_pubkey);
    usersPerLocation.set(locCode, locUsers);
  }

  const { devices, deviceNameMap } = buildDevices(parsed, usersPerLocation, locToMetro);

  const input: ShapleyInput = {
    devices,
    private_links: buildPrivateLinks(parsed, locToMetro, deviceNameMap),
    public_links: buildPublicLinks(raw),
    demands: buildDemands(
      parsed.cityDemands,
      parsed.totalSlots,
      usersPerLocation,
      locToMetro
    ),
    operator_uptime: SHAPLEY_PARAMS.operatorUptime,
    contiguity_bonus: SHAPLEY_PARAMS.contiguityBonus,
    demand_multiplier: SHAPLEY_PARAMS.demandMultiplier,
  };

  return { input, deviceNameMap };
}

/**
 * Build the ShapleyInput (backwards-compatible wrapper).
 */
export function buildShapleyInput(
  raw: RawSnapshot,
  parsed: ParsedSnapshot
): ShapleyInput {
  return buildShapleyInputWithMap(raw, parsed).input;
}
