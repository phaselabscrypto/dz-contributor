/**
 * NOT IMPLEMENTED
 *
 * Decoder registry for the Metro, Device and Link accounts. Exports
 * `stubRegistry`, which throws on every call.
 *
 * `anchorRegistry` below was written on the assumption that an Anchor
 * IDL was needed. It is not: those accounts sit on the serviceability
 * program that `contributor-directory.ts` already reads by verified
 * byte offsets. `borsh-registry.ts` is the closer starting point.
 *
 * The `Registry` interface is the single point of coupling, so swapping
 * an implementation in leaves every call site unchanged.
 *
 * This does not gate contributor-rewards or contributor-directory
 * reads, which have their own verified decoders.
 */

import type {
  OnchainMetro,
  OnchainDevice,
  OnchainLink,
  OnchainContributor,
} from "./decoders";
import { OnchainNotConfigured } from "./decoders";

export interface Registry {
  decodeMetro(pubkey: string, data: Buffer): OnchainMetro;
  decodeDevice(pubkey: string, data: Buffer): OnchainDevice;
  decodeLink(pubkey: string, data: Buffer): OnchainLink;
  decodeContributor(pubkey: string, data: Buffer): OnchainContributor;
}

/** Throws on every call. Active until a real registry is implemented. */
export const stubRegistry: Registry = {
  decodeMetro: () => {
    throw new OnchainNotConfigured("Metro");
  },
  decodeDevice: () => {
    throw new OnchainNotConfigured("Device");
  },
  decodeLink: () => {
    throw new OnchainNotConfigured("Link");
  },
  decodeContributor: () => {
    throw new OnchainNotConfigured("Contributor");
  },
};

/**
 * Anchor-backed registry, never wired. Kept only as a record of the
 * earlier approach. Reading these accounts needs no IDL and no Anchor
 * dependency, so prefer `borsh-registry.ts` or a direct byte-offset
 * decoder modelled on `contributor-directory.ts`.
 */
export const anchorRegistry: Registry = {
  decodeMetro: (pubkey, _data) => {
    // const idl = require("./idl/dz-registry.idl.json");
    // const coder = new BorshAccountsCoder(idl);
    // const account = coder.decode("Metro", _data);
    // return {
    //   pk: pubkey,
    //   code: account.code,
    //   name: account.name,
    //   latitude: account.latitude,
    //   longitude: account.longitude,
    // };
    void pubkey;
    throw new OnchainNotConfigured("Metro (anchor not wired)");
  },

  decodeDevice: (pubkey, _data) => {
    void pubkey;
    throw new OnchainNotConfigured("Device (anchor not wired)");
  },

  decodeLink: (pubkey, _data) => {
    void pubkey;
    throw new OnchainNotConfigured("Link (anchor not wired)");
  },

  decodeContributor: (pubkey, _data) => {
    void pubkey;
    throw new OnchainNotConfigured("Contributor (anchor not wired)");
  },
};
