/**
 * NOT IMPLEMENTED
 *
 * Decoders for the Metro, Device and Link accounts on the DoubleZero
 * serviceability program. Every function throws `OnchainNotConfigured`
 * because no layout has been written for those three account types.
 *
 * This is our own remaining work, not an external dependency. No
 * program IDL is required. `contributor-directory.ts` reads
 * `AccountType::Contributor` from the same program using byte offsets
 * verified against every live account, and `dz-rewards-record.ts`
 * decodes reward records on the record program the same way. Follow
 * either one.
 *
 * See `lib/onchain/README.md` for what each stub needs.
 */

export class OnchainNotConfigured extends Error {
  constructor(component: string) {
    super(
      `On-chain decoder for ${component} is not implemented. ` +
        `See lib/onchain/README.md; use the malbeclabs HTTP source via ` +
        `/api/live/* routes instead.`,
    );
    this.name = "OnchainNotConfigured";
  }
}

export interface OnchainMetro {
  pk: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface OnchainDevice {
  pk: string;
  code: string;
  status: string;
  deviceType: string;
  metroPk: string;
  contributorPk: string;
  contributorCode: string;
}

export interface OnchainLink {
  pk: string;
  code: string;
  status: string;
  linkType: string;
  bandwidthBps: number;
  sideAPk: string;
  sideZPk: string;
  contributorCode: string;
  latencyUs: number;
}

export interface OnchainContributor {
  pk: string;
  code: string;
}

// ─────────────────────────────────────────────────────────────────────
// Decoder registry
//
// All four decoders below delegate to the active registry. Point this
// import at a registry that implements the layouts and every call site
// stays the same. `borsh-registry.ts` is the closest starting point.
// ─────────────────────────────────────────────────────────────────────
import { stubRegistry as registry } from "./idl-registry";
// import { borshRegistry as registry } from "./borsh-registry";

export function decodeMetro(pubkey: string, data: Buffer): OnchainMetro {
  return registry.decodeMetro(pubkey, data);
}

export function decodeDevice(pubkey: string, data: Buffer): OnchainDevice {
  return registry.decodeDevice(pubkey, data);
}

export function decodeLink(pubkey: string, data: Buffer): OnchainLink {
  return registry.decodeLink(pubkey, data);
}

export function decodeContributor(
  pubkey: string,
  data: Buffer,
): OnchainContributor {
  return registry.decodeContributor(pubkey, data);
}

/**
 * Helper for tests + the eventual real implementation: take a base64 string
 * (as the RPC returns it) and yield a Buffer.
 */
export function dataToBuffer(data: [string, "base64"]): Buffer {
  return Buffer.from(data[0], "base64");
}
