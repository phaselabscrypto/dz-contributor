/**
 * Borsh schemas for DoubleZero on-chain accounts.
 *
 * These are unverified placeholders. The shapes assume standard
 * registry-program patterns: fixed-size enums as u8, strings as
 * length-prefixed UTF-8, pubkeys as 32-byte arrays formatted to base58
 * during decode. No field has been checked against a live account.
 *
 * No IDL is needed to finish them. Read a live account and confirm each
 * offset, the way `contributor-directory.ts` did for the contributor
 * layout. Then:
 *   1. Replace the schemas below with the verified shapes.
 *   2. Set `haveSchemas = true`.
 *   3. Check them with `pnpm test:borsh`.
 *   4. In `decoders.ts` swap `stubRegistry` for `borshRegistry`.
 *
 * Each `Raw*` type is what borsh emits — snake_case fields. The registry
 * maps these to the camelCase `Onchain*` types the rest of the app
 * already consumes, so swapping the schema in does not ripple outward.
 */

import type { Schema } from "borsh";

/** Flip to true once every schema is verified against a live account. */
export const haveSchemas = false;

// ---------------------------------------------------------------------------
// Metro
// ---------------------------------------------------------------------------

export interface RawMetro {
  code: string;
  name: string;
  latitude: number;
  longitude: number;
}

export const metroSchema: Schema = {
  struct: {
    code: "string",
    name: "string",
    latitude: "f64",
    longitude: "f64",
  },
};

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

export interface RawDevice {
  code: string;
  status: string;
  device_type: string;
  metro_pk: string;
  contributor_pk: string;
  contributor_code: string;
}

export const deviceSchema: Schema = {
  struct: {
    code: "string",
    status: "string",
    device_type: "string",
    metro_pk: "string",
    contributor_pk: "string",
    contributor_code: "string",
  },
};

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

export interface RawLink {
  code: string;
  status: string;
  link_type: string;
  bandwidth_bps: bigint;
  side_a_pk: string;
  side_z_pk: string;
  contributor_code: string;
  latency_us: bigint;
}

export const linkSchema: Schema = {
  struct: {
    code: "string",
    status: "string",
    link_type: "string",
    bandwidth_bps: "u64",
    side_a_pk: "string",
    side_z_pk: "string",
    contributor_code: "string",
    latency_us: "u64",
  },
};

// ---------------------------------------------------------------------------
// Contributor
// ---------------------------------------------------------------------------

export interface RawContributor {
  code: string;
}

export const contributorSchema: Schema = {
  struct: {
    code: "string",
  },
};
