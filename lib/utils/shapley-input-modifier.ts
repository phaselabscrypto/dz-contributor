import type { ShapleyInput } from "@/lib/types/shapley";
import type { RawSnapshot } from "@/lib/types/snapshot";
import type { ParsedSnapshot } from "@/lib/types/contributor";
import {
  buildCityNameToMetro,
  buildLocationCodeToMetro,
  metroFromDevice,
} from "./shapley-input-builder";

interface AddLinkSpec {
  cityA: string; // locationCode
  cityZ: string; // locationCode
  /** Bandwidth in Gbps. Defaults to 10G to match the spec presets. */
  bandwidthGbps?: number;
  /** Round-trip latency in ms. Defaults to 10ms (typical fibre RTT). */
  latencyMs?: number;
}

/**
 * Creates a modified copy of a ShapleyInput for what-if simulation:
 * removes specified links and adds new ones for the given contributor.
 *
 * Demand overrides are NOT handled here — they are applied by regenerating
 * the demand table from override-patched city stats (see
 * `lib/utils/demand-overrides.ts`), the only DZ-faithful way to change a
 * metro's validator count. Scaling existing rows breaks the solver's
 * per-type (start, traffic, multicast) uniformity invariant.
 */
export function modifyShapleyInput(
  baselineInput: ShapleyInput,
  parsed: ParsedSnapshot,
  raw: RawSnapshot,
  contributorCode: string,
  removeLinkPubkeys: string[],
  addLinks: AddLinkSpec[]
): ShapleyInput {
  // Deep clone baseline
  const input: ShapleyInput = {
    devices: baselineInput.devices.map((d) => ({ ...d })),
    private_links: baselineInput.private_links.map((l) => ({ ...l })),
    public_links: baselineInput.public_links.map((l) => ({ ...l })),
    demands: baselineInput.demands.map((d) => ({ ...d })),
    operator_uptime: baselineInput.operator_uptime,
    contiguity_bonus: baselineInput.contiguity_bonus,
    demand_multiplier: baselineInput.demand_multiplier,
    // City weights are the leader-schedule stake share — invariant under
    // link/device/demand what-ifs (stake = leader slots, not topology), so the
    // modified run reuses the baseline weights unchanged. Copy so the modified
    // input is self-contained on the wire.
    city_weights: baselineInput.city_weights
      ? { ...baselineInput.city_weights }
      : undefined,
  };

  // Build location→metro mapping
  const cityNameToMetro = buildCityNameToMetro(raw);
  const locToMetro = buildLocationCodeToMetro(raw, cityNameToMetro);

  const contributor = parsed.contributors.find(
    (c) => c.code === contributorCode
  );

  // --- Remove links (only if contributor exists) ---
  if (contributor) {
    for (const pubkey of removeLinkPubkeys) {
      const link = contributor.links.find((l) => l.pubkey === pubkey);
      if (!link) continue;

      const metro1 = locToMetro.get(link.sideA.locationCode);
      const metro2 = locToMetro.get(link.sideZ.locationCode);
      if (!metro1 || !metro2) continue;

      // Remove first matching private_link for this metro pair owned by this contributor
      // (both endpoints must have a device belonging to this contributor at the right metro)
      const contributorDevices = new Set(
        input.devices
          .filter((d) => d.operator === contributorCode)
          .map((d) => d.device)
      );
      const idx = input.private_links.findIndex(
        (pl) => {
          const plMetro1 = metroFromDevice(pl.device1);
          const plMetro2 = metroFromDevice(pl.device2);
          return (
            ((plMetro1 === metro1 && plMetro2 === metro2) ||
             (plMetro1 === metro2 && plMetro2 === metro1)) &&
            contributorDevices.has(pl.device1) &&
            contributorDevices.has(pl.device2)
          );
        }
      );
      if (idx !== -1) input.private_links.splice(idx, 1);
    }
  }

  // --- Add links ---
  for (const addLink of addLinks) {
    const metro1 = locToMetro.get(addLink.cityA);
    const metro2 = locToMetro.get(addLink.cityZ);
    if (!metro1 || !metro2 || metro1 === metro2) continue;

    /**
     * Find or create a device for the contributor at the given metro.
     * If the contributor already has a device there, reuse it.
     * Otherwise allocate the next available number for that metro
     * (across ALL operators) and add the device.
     */
    const ensureDevice = (metro: string): string => {
      // Check if this contributor already has a device at this metro
      const existing = input.devices.find(
        (d) => d.operator === contributorCode && metroFromDevice(d.device) === metro
      );
      if (existing) return existing.device;

      // Find the next available number for this metro across all operators
      let maxN = 0;
      for (const d of input.devices) {
        if (metroFromDevice(d.device) === metro) {
          const suffix = d.device.slice(metro.length);
          const n = parseInt(suffix, 10);
          if (!isNaN(n) && n > maxN) maxN = n;
        }
      }
      const deviceName = `${metro}${maxN + 1}`;
      // Use the same 10 Gbps fallback as the heuristic builder
      input.devices.push({
        device: deviceName,
        edge: 10_000,
        operator: contributorCode,
      });
      return deviceName;
    };

    const device1 = ensureDevice(metro1);
    const device2 = ensureDevice(metro2);

    input.private_links.push({
      device1,
      device2,
      latency: addLink.latencyMs ?? 10,
      bandwidth: addLink.bandwidthGbps ?? 10,
      uptime: 0.99,
      shared: null,
    });
  }

  // --- Remove orphaned devices ---
  // Find all device names that still appear in any remaining private link
  const activeDeviceNames = new Set<string>();
  for (const pl of input.private_links) {
    if (
      input.devices.some(
        (d) => d.device === pl.device1 && d.operator === contributorCode
      )
    ) {
      activeDeviceNames.add(pl.device1);
    }
    if (
      input.devices.some(
        (d) => d.device === pl.device2 && d.operator === contributorCode
      )
    ) {
      activeDeviceNames.add(pl.device2);
    }
  }

  input.devices = input.devices.filter(
    (d) => d.operator !== contributorCode || activeDeviceNames.has(d.device)
  );

  return input;
}
