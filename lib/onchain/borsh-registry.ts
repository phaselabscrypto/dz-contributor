/**
 * Borsh-backed decoder registry for Metro, Device and Link accounts.
 *
 * Uses raw borsh rather than @coral-xyz/anchor because only decode is
 * needed, not transaction signing or RPC plumbing. Anchor would add
 * ~200KB for features this app does not use.
 *
 * To finish it:
 *   1. Verify each account layout against a live account, the way
 *      `contributor-directory.ts` verified the contributor layout.
 *   2. Write the schemas in `lib/onchain/idl/schemas.ts` and set
 *      `haveSchemas = true`.
 *   3. In decoders.ts, swap `stubRegistry` for `borshRegistry`.
 *
 * The schemas are unverified placeholders until step 1 is done, so
 * every call throws rather than returning wrong data.
 */

import { deserialize } from "borsh";
import type {
  OnchainMetro,
  OnchainDevice,
  OnchainLink,
  OnchainContributor,
} from "./decoders";
import { OnchainNotConfigured } from "./decoders";
import type { Registry } from "./idl-registry";
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
} from "./idl/schemas";

/**
 * Strip Anchor's 8-byte account discriminator if present. Anchor
 * accounts carry a leading 8-byte discriminator that is not part of the
 * borsh struct, so trim it before deserialization. Set
 * `DZ_ACCOUNT_HAS_DISCRIMINATOR=0` for raw borsh structs. The
 * serviceability accounts verified so far use a single account-type
 * byte instead, so check the real layout before trusting this default.
 */
function payload(data: Buffer): Uint8Array {
  if (process.env.DZ_ACCOUNT_HAS_DISCRIMINATOR === "0") {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.subarray(8));
}

function notReady(component: string): never {
  throw new OnchainNotConfigured(
    `${component} — schemas in lib/onchain/idl/schemas.ts are still placeholders`,
  );
}

export const borshRegistry: Registry = {
  decodeMetro: (pubkey, data): OnchainMetro => {
    if (!haveSchemas) notReady("Metro");
    const raw = deserialize(metroSchema, payload(data)) as RawMetro;
    return {
      pk: pubkey,
      code: raw.code,
      name: raw.name,
      latitude: raw.latitude,
      longitude: raw.longitude,
    };
  },

  decodeDevice: (pubkey, data): OnchainDevice => {
    if (!haveSchemas) notReady("Device");
    const raw = deserialize(deviceSchema, payload(data)) as RawDevice;
    return {
      pk: pubkey,
      code: raw.code,
      status: raw.status,
      deviceType: raw.device_type,
      metroPk: raw.metro_pk,
      contributorPk: raw.contributor_pk,
      contributorCode: raw.contributor_code,
    };
  },

  decodeLink: (pubkey, data): OnchainLink => {
    if (!haveSchemas) notReady("Link");
    const raw = deserialize(linkSchema, payload(data)) as RawLink;
    return {
      pk: pubkey,
      code: raw.code,
      status: raw.status,
      linkType: raw.link_type,
      bandwidthBps: Number(raw.bandwidth_bps),
      sideAPk: raw.side_a_pk,
      sideZPk: raw.side_z_pk,
      contributorCode: raw.contributor_code,
      latencyUs: Number(raw.latency_us),
    };
  },

  decodeContributor: (pubkey, data): OnchainContributor => {
    if (!haveSchemas) notReady("Contributor");
    const raw = deserialize(contributorSchema, payload(data)) as RawContributor;
    return {
      pk: pubkey,
      code: raw.code,
    };
  },
};
