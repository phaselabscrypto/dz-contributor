/**
 * ⚠️ SCAFFOLDING — NOT LIVE
 *
 * Decoder registry for the DZ registry program (Metro / Device / Link /
 * Contributor). Currently exports `stubRegistry`, which throws on every
 * call.
 *
 * Activation (single-line swap):
 *
 *   1. Drop `dz-registry.idl.json` into `./idl/`
 *   2. Build `anchorRegistry` here using the IDL + a borsh layout per
 *      account type
 *   3. In `decoders.ts`, change:
 *        import { stubRegistry as registry } from "./idl-registry";
 *      to:
 *        import { anchorRegistry as registry } from "./idl-registry";
 *
 * The `Registry` interface is the single point of coupling — every
 * consumer call site stays unchanged.
 *
 * NOTE: this does NOT gate contributor-rewards or contributor-directory
 * reads. Those have their own bit-verified decoders in
 * `dz-rewards-record.ts` and `contributor-directory.ts`. See
 * `lib/onchain/README.md` for the live-vs-stub matrix.
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

/** Throws on every call. Active until the IDL drops. */
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
 * Anchor-backed registry. Wired up but not exported as the active
 * registry until the IDL files exist in ./idl/.
 *
 * To activate after IDL drop:
 *   1. Drop ./idl/dz-registry.idl.json
 *   2. `npm install @coral-xyz/anchor` (or `borsh` for raw decoding)
 *   3. Uncomment the implementation below
 *   4. In decoders.ts, swap `stubRegistry` for `anchorRegistry`
 *
 * The shape below is best-guess based on standard Anchor account layouts;
 * adjust field names once the canonical IDL is in hand.
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
