/**
 * Borsh-backed decoder registry.
 *
 * Uses raw borsh (not @coral-xyz/anchor) because we only need decode, not
 * transaction signing or RPC plumbing. Anchor would add ~200KB for two
 * features we won't use.
 *
 * Activation:
 *   1. Drop the canonical schemas at `lib/onchain/idl/schemas.ts` (see
 *      template at the bottom of this file).
 *   2. In decoders.ts, swap `stubRegistry` for `borshRegistry`.
 *
 * Until step 1 lands, the schemas are best-guesses. The decoder swap to
 * the real schemas should be a search-and-replace, not a rewrite.
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
 * Strip Anchor's 8-byte account discriminator if present. Most Anchor
 * accounts ship with a leading 8-byte discriminator that is NOT part of
 * the borsh struct. We trim it before deserialization. If the canonical
 * IDL turns out to be raw borsh (no discriminator), set
 * `DZ_ACCOUNT_HAS_DISCRIMINATOR=0` in env.
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
