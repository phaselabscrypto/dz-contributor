// Parsed/enriched contributor types used by the UI

export interface Contributor {
  code: string;
  pubkey: string;
  status: string;
  deviceCount: number;
  linkCount: number;
  cities: string[];
  devices: Device[];
  links: Link[];
  /**
   * Naïve linear-heuristic share of rewards (0-1). NOT the canonical
   * Shapley share. Computed in `snapshot-parser.ts` as a directional
   * estimate when the LP solver is unavailable. Use `share` from the
   * Shapley API for the canonical value.
   */
  linearShare: number;
}

export interface Device {
  pubkey: string;
  locationCode: string;
  locationName: string;
  exchangeCode: string;
  exchangeName: string;
  deviceType: string;
  contributorCode: string;
  health: string;
  maxUsers: number;
}

export interface Link {
  pubkey: string;
  sideA: LinkEndpoint;
  sideZ: LinkEndpoint;
  linkType: string;
  bandwidthGbps: number;
  delayMs: number;
  jitterMs: number;
  contributorCode: string;
  health: string;
}

export interface LinkEndpoint {
  devicePubkey: string;
  locationCode: string;
  locationName: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
}

export interface Location {
  pubkey: string;
  code: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
}

export interface Exchange {
  pubkey: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  devicePairs: number;
}

export interface CityDemand {
  locationCode: string;
  locationName: string;
  country: string;
  validatorCount: number;
  totalSlots: number;
  linkCount: number;
  demandScore: number; // higher = more underserved high-demand city
}

export interface ParsedSnapshot {
  dzEpoch: number;
  solanaEpoch: number;
  contributors: Contributor[];
  locations: Location[];
  exchanges: Exchange[];
  cityDemands: CityDemand[];
  totalSlots: number;
  totalValidators: number;
  version: string;
  timestamp: string;
}
