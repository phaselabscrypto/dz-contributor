/**
 * Build a ShapleyInput directly from the live topology + validator data.
 *
 * Use this for "what's the network's Shapley state RIGHT NOW" — independent
 * of the historical S3 snapshot pipeline. Useful as a simulator baseline
 * anchor and for the economics page.
 *
 * Demand: derived from validators-per-metro. Each metro with at least one
 * publishing validator becomes a demand sink, with traffic ~ stake share.
 * Public links: minimal placeholder mesh between metros at a default
 * latency (replaced with the canonical table when DZ ships #3).
 */

import type { ShapleyInput } from "@/lib/types/shapley";
import type { LiveTopology } from "@/lib/types/live";
import { SHAPLEY_PARAMS } from "@/lib/constants/config";

/** Default public-internet latency (ms) between any two metros where we
 *  don't yet have a canonical entry. 60ms approximates median trans-regional
 *  internet hops. Overridden when DZ #3 lands. */
const DEFAULT_PUBLIC_LATENCY_MS = 60;

/** Default link latency (ms) when topology reports 0us. */
const DEFAULT_LINK_LATENCY_MS = 5;

/** Bandwidth floor in Gbps so the LP doesn't drop links to zero capacity. */
const MIN_BANDWIDTH_GBPS = 1;

export function buildLiveShapleyInput(topology: LiveTopology): ShapleyInput {
  // --- Devices: one entry per (device, contributor). Mark `edge=1` for
  //     devices with at least one validator attached. ---
  const validatorsPerDevice = new Map<string, number>();
  for (const v of topology.validators) {
    validatorsPerDevice.set(
      v.devicePk,
      (validatorsPerDevice.get(v.devicePk) ?? 0) + 1,
    );
  }

  const devices = topology.devices
    .filter((d) => d.metroCode && d.contributorCode)
    .map((d) => ({
      device: d.metroCode.toUpperCase(),
      edge: validatorsPerDevice.get(d.pk) ? 1 : 0,
      operator: d.contributorCode,
    }));

  // --- Private links: one per topology link. Aggregate by metro pair so
  //     the LP gets a single edge per pair per contributor. ---
  const private_links = topology.links
    .filter((l) => l.sideAMetro && l.sideZMetro && l.contributorCode)
    .map((l) => {
      const latencyMs =
        l.latencyUs > 0 ? l.latencyUs / 1000 : DEFAULT_LINK_LATENCY_MS;
      const bandwidthGbps = Math.max(
        l.bandwidthBps / 1e9,
        MIN_BANDWIDTH_GBPS,
      );
      return {
        device1: l.sideAMetro.toUpperCase(),
        device2: l.sideZMetro.toUpperCase(),
        latency: latencyMs,
        bandwidth: bandwidthGbps,
        uptime: l.status === "activated" ? 0.99 : 0.5,
        shared: null,
      };
    });

  // --- Public links: pairwise mesh between every metro that hosts a
  //     device. Latency placeholder until DZ ships the canonical table. ---
  const metros = Array.from(
    new Set(devices.map((d) => d.device).filter((m): m is string => !!m)),
  ).sort();

  const public_links: Array<{
    city1: string;
    city2: string;
    latency: number;
  }> = [];
  for (let i = 0; i < metros.length; i++) {
    for (let j = i + 1; j < metros.length; j++) {
      public_links.push({
        city1: metros[i],
        city2: metros[j],
        latency: DEFAULT_PUBLIC_LATENCY_MS,
      });
    }
  }

  // --- Demand: derive from validator count per metro. Each metro becomes
  //     both a source and sink, weighted by validator count. ---
  const validatorsPerMetro = new Map<string, number>();
  const devicePkToMetro = new Map<string, string>();
  for (const d of topology.devices) devicePkToMetro.set(d.pk, d.metroCode);
  for (const v of topology.validators) {
    const m = devicePkToMetro.get(v.devicePk);
    if (!m) continue;
    validatorsPerMetro.set(m, (validatorsPerMetro.get(m) ?? 0) + 1);
  }

  const demands: ShapleyInput["demands"] = [];
  const metroList = [...validatorsPerMetro.keys()].sort();
  for (const a of metroList) {
    for (const b of metroList) {
      if (a === b) continue;
      const recv = validatorsPerMetro.get(b) ?? 0;
      if (recv === 0) continue;
      demands.push({
        start: a.toUpperCase(),
        end: b.toUpperCase(),
        receivers: recv,
        traffic: 1.0,
        priority: 1,
        type: 1,
        multicast: false,
      });
    }
  }

  return {
    devices,
    private_links,
    public_links,
    demands,
    operator_uptime: SHAPLEY_PARAMS.operatorUptime,
    contiguity_bonus: SHAPLEY_PARAMS.contiguityBonus,
    demand_multiplier: SHAPLEY_PARAMS.demandMultiplier,
  };
}
