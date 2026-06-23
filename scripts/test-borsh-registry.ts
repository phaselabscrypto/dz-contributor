#!/usr/bin/env tsx
/**
 * Borsh registry plumbing test.
 *
 * Constructs synthetic accounts conforming to the schemas in
 * `lib/onchain/idl/schemas.ts`, encodes them with borsh, and round-trips
 * through `borshRegistry`. Asserts the decoded shape matches the input.
 *
 * Today this exercises the placeholder schemas. When DZ ships the real
 * IDL, this file becomes a regression pin: as long as it passes, we know
 * the registry plumbing is intact regardless of schema shape changes.
 *
 * Usage:
 *   npx tsx scripts/test-borsh-registry.ts
 */

import { serialize } from "borsh";
import {
  metroSchema,
  deviceSchema,
  linkSchema,
  contributorSchema,
  haveSchemas,
  type RawMetro,
  type RawDevice,
  type RawLink,
  type RawContributor,
} from "../lib/onchain/idl/schemas";
import { borshRegistry } from "../lib/onchain/borsh-registry";
import { OnchainNotConfigured } from "../lib/onchain/decoders";

let pass = 0;
let fail = 0;

function eq<T>(label: string, actual: T, expected: T) {
  const a = JSON.stringify(actual, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  const e = JSON.stringify(expected, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  if (a === e) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    got:      ${a}`);
    fail++;
  }
}

/** Build a synthetic account buffer with leading 8-byte discriminator. */
function withDiscriminator(payload: Uint8Array): Buffer {
  const out = Buffer.alloc(8 + payload.length);
  // dummy discriminator; registry strips first 8 bytes by default
  Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).copy(out, 0);
  Buffer.from(payload).copy(out, 8);
  return out;
}

function testMetro() {
  console.log("\nMetro");
  const raw: RawMetro = {
    code: "ams",
    name: "Amsterdam",
    latitude: 52.3676,
    longitude: 4.9041,
  };
  const encoded = serialize(metroSchema, raw);
  const decoded = borshRegistry.decodeMetro(
    "MetroPK111111111111111111",
    withDiscriminator(encoded),
  );
  eq("pk passthrough", decoded.pk, "MetroPK111111111111111111");
  eq("code", decoded.code, "ams");
  eq("name", decoded.name, "Amsterdam");
  eq("latitude", decoded.latitude, 52.3676);
  eq("longitude", decoded.longitude, 4.9041);
}

function testDevice() {
  console.log("\nDevice");
  const raw: RawDevice = {
    code: "dz-ams-sw01",
    status: "activated",
    device_type: "transit",
    metro_pk: "MetroPK111111111111111111",
    contributor_pk: "ContribPK11111111111111111",
    contributor_code: "jump_",
  };
  const encoded = serialize(deviceSchema, raw);
  const decoded = borshRegistry.decodeDevice(
    "DevicePK1111111111111111",
    withDiscriminator(encoded),
  );
  eq("code", decoded.code, "dz-ams-sw01");
  eq("status", decoded.status, "activated");
  eq("deviceType (camelCase mapped)", decoded.deviceType, "transit");
  eq("contributorCode", decoded.contributorCode, "jump_");
}

function testLink() {
  console.log("\nLink");
  const raw: RawLink = {
    code: "ams-fra-100g",
    status: "activated",
    link_type: "WAN",
    bandwidth_bps: 100_000_000_000n,
    side_a_pk: "DevicePK1111111111111111",
    side_z_pk: "DevicePK2222222222222222",
    contributor_code: "jump_",
    latency_us: 5596n,
  };
  const encoded = serialize(linkSchema, raw);
  const decoded = borshRegistry.decodeLink(
    "LinkPK1111111111111111",
    withDiscriminator(encoded),
  );
  eq("code", decoded.code, "ams-fra-100g");
  eq("linkType", decoded.linkType, "WAN");
  eq("bandwidthBps (bigint→number)", decoded.bandwidthBps, 100_000_000_000);
  eq("latencyUs (bigint→number)", decoded.latencyUs, 5596);
}

function testContributor() {
  console.log("\nContributor");
  const raw: RawContributor = { code: "dgt" };
  const encoded = serialize(contributorSchema, raw);
  const decoded = borshRegistry.decodeContributor(
    "ContribPK11111111111111111",
    withDiscriminator(encoded),
  );
  eq("code", decoded.code, "dgt");
}

function testNoDiscriminator() {
  console.log("\nNo-discriminator mode (DZ_ACCOUNT_HAS_DISCRIMINATOR=0)");
  const raw: RawMetro = {
    code: "fra",
    name: "Frankfurt",
    latitude: 50.1109,
    longitude: 8.6821,
  };
  const encoded = serialize(metroSchema, raw);
  const prev = process.env.DZ_ACCOUNT_HAS_DISCRIMINATOR;
  process.env.DZ_ACCOUNT_HAS_DISCRIMINATOR = "0";
  try {
    const decoded = borshRegistry.decodeMetro(
      "MetroPK333333333333333333",
      Buffer.from(encoded),
    );
    eq("decode without discriminator", decoded.code, "fra");
  } finally {
    if (prev === undefined) delete process.env.DZ_ACCOUNT_HAS_DISCRIMINATOR;
    else process.env.DZ_ACCOUNT_HAS_DISCRIMINATOR = prev;
  }
}

function main() {
  console.log("Borsh registry plumbing test");
  console.log(`haveSchemas = ${haveSchemas}`);

  if (!haveSchemas) {
    // Plumbing test: confirm the not-ready guard fires correctly.
    console.log("\nGuard rail (placeholders active)");
    try {
      borshRegistry.decodeMetro("x", Buffer.alloc(64));
      console.log("  ✗ expected OnchainNotConfigured");
      fail++;
    } catch (err) {
      if (err instanceof OnchainNotConfigured) {
        console.log("  ✓ throws OnchainNotConfigured when schemas are placeholders");
        pass++;
      } else {
        console.log(`  ✗ wrong error: ${err}`);
        fail++;
      }
    }
    console.log("\nSkipping decode tests (haveSchemas=false).");
    console.log("Once DZ ships the real IDL, set haveSchemas=true and re-run.");
  } else {
    // Real schemas — exercise every decoder.
    testMetro();
    testDevice();
    testLink();
    testContributor();
    testNoDiscriminator();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
