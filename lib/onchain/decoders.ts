/**
 * ⚠️ SCAFFOLDING — NOT LIVE
 *
 * Borsh decoders for the DZ registry program (Metro / Device / Link /
 * Contributor). Every function in this file throws `OnchainNotConfigured`
 * until DZ ships the IDL and `idl-registry.ts` is flipped from
 * `stubRegistry` to `anchorRegistry`.
 *
 * See `lib/onchain/README.md` for the live-vs-stub matrix and the
 * activation checklist.
 *
 * NB: this does NOT block contributor-rewards / contributor-directory
 * reads — those use their own verified decoders in `dz-rewards-record.ts`
 * and `contributor-directory.ts`, which read from different DZ programs
 * (record + serviceability) where the layouts are already known and
 * bit-verified against live mainnet data.
 */

export class OnchainNotConfigured extends Error {
  constructor(component: string) {
    super(
      `On-chain decoder for ${component} is not configured yet — ` +
        `pending DZ IDL. See lib/onchain/README.md for the activation ` +
        `checklist; until then, use the malbeclabs HTTP source via ` +
        `/api/live/* routes.`,
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
// All four decoders below delegate to the active registry. To swap from
// stubs to real Anchor-backed decoders once DZ ships the IDL, change
// the import below from `stubRegistry` to `anchorRegistry`. That's the
// entire swap — every call site stays the same.
// ─────────────────────────────────────────────────────────────────────
import { stubRegistry as registry } from "./idl-registry";
// import { anchorRegistry as registry } from "./idl-registry";

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
