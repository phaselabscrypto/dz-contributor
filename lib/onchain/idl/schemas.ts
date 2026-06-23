/**
 * Borsh schemas for DoubleZero on-chain accounts.
 *
 * These are best-guess placeholders pending the canonical IDL from DZ
 * Foundation (Q6). The shapes follow standard registry-program patterns
 * — fixed-size enums encoded as u8, strings as length-prefixed UTF-8,
 * pubkeys as 32-byte arrays formatted to base58 strings during decode.
 *
 * Activation: when DZ ships `dz-registry.idl.json`:
 *   1. Replace the schemas below with ones derived from the real IDL.
 *   2. Set `haveSchemas = true`.
 *   3. Verify with the unit tests in `borsh-registry.test.ts`.
 *   4. In `decoders.ts` swap `stubRegistry` for `borshRegistry`.
 *
 * Each `Raw*` type is what borsh emits — snake_case fields. The registry
 * maps these to the camelCase `Onchain*` types the rest of the app
 * already consumes, so swapping the schema in does not ripple outward.
 */

import type { Schema } from "borsh";

/** Flip to true once schemas reflect the canonical IDL. */
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
