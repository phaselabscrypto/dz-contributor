import assert from "node:assert/strict";
import type {
  RawContributor,
  RawDevice,
  RawLink,
  RawLocation,
  RawSnapshot,
} from "@/lib/types/snapshot";
import { extractDiffShape } from "@/lib/utils/diff-shape";

function location(code: string): RawLocation {
  return { account_type: "Location", lat: 0, lng: 0, code, name: code, country: "NL", status: "activated", reference_count: 0 };
}

function contributor(code: string): RawContributor {
  return { account_type: "Contributor", status: "activated", code, reference_count: 0, ops_manager_pk: "" };
}

function device(location_pk: string, contributor_pk: string): RawDevice {
  return { account_type: "Device", location_pk, exchange_pk: "", device_type: "Switch", contributor_pk, device_health: "ok", max_users: 0, status: "activated", code: location_pk, users_count: 0 };
}

function link(side_a_pk: string, side_z_pk: string, contributor_pk: string, bandwidth: number, link_type: string): RawLink {
  return { account_type: "Link", side_a_pk, side_z_pk, link_type, bandwidth, delay_ns: 0, jitter_ns: 0, contributor_pk, link_health: "ok", status: "activated", code: side_a_pk + side_z_pk };
}

function snapshot(serviceability: RawSnapshot["fetch_data"]["dz_serviceability"]): RawSnapshot {
  return {
    dz_epoch: 211,
    solana_epoch: 900,
    fetch_data: {
      dz_serviceability: serviceability,
      dz_telemetry: { device_latency_samples: [] },
      dz_internet: { internet_latency_samples: [] },
    },
    leader_schedule: { solana_epoch: 900, schedule_map: {} },
    metadata: { created_at: "", network: "test", exchanges_count: 0, locations_count: 0, devices_count: 0, internet_samples_count: 0, device_samples_count: 0 },
  };
}

// Keys are deliberately not in sorted order: snapshot insertion order is the contract.
const shape = extractDiffShape(snapshot({
  locations: { LocA: location("AMS"), LocB: location("FRA") },
  contributors: { ContribOne: contributor("one"), ContribTwo: contributor("two") },
  devices: {
    DevA1: device("LocA", "ContribOne"),
    DevB1: device("LocB", "ContribOne"),
    DevB2: device("LocB", "ContribTwo"),
    DevOrphan: device("LocMissing", "ContribMissing"),
  },
  links: {
    LinkZ: link("DevB1", "DevA1", "ContribOne", 10_000_000_000, "WAN"),
    LinkA: link("DevA1", "DevB2", "ContribTwo", 2_500_000_000, "WAN"),
    LinkOrphan: link("DevOrphan", "DevUnknown", "ContribMissing", 1_000_000_000, "DZX"),
  },
  exchanges: {},
  users: {},
}));

assert.equal(shape.epoch, 211);
assert.deepEqual(shape.links, [
  { pubkey: "LinkZ", contributorCode: "one", sideACode: "FRA", sideZCode: "AMS", bandwidthGbps: 10, linkType: "WAN" },
  { pubkey: "LinkA", contributorCode: "two", sideACode: "AMS", sideZCode: "FRA", bandwidthGbps: 2.5, linkType: "WAN" },
  { pubkey: "LinkOrphan", contributorCode: "unknown", sideACode: "", sideZCode: "", bandwidthGbps: 1, linkType: "DZX" },
]);
assert.deepEqual(shape.contributors, [
  { code: "one", linkCount: 1, deviceCount: 2, metroCount: 2 },
  { code: "two", linkCount: 1, deviceCount: 1, metroCount: 1 },
]);

const empty = extractDiffShape(snapshot({ locations: {}, contributors: {}, devices: {}, links: {}, exchanges: {}, users: {} }));
assert.deepEqual(empty, { epoch: 211, links: [], contributors: [] });

console.log("diff shape extraction (offline): passed");
