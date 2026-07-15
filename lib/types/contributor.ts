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
  /**
   * Uppercased exchange (metro) code this location maps to, via the same
   * name-based join the server uses for link endpoints
   * (buildLocationCodeToMetro). Undefined when the location name matches no
   * exchange.
   */
  metroCode?: string;
  metroName?: string;
}

/**
 * Per-metro demand row for the simulator's "Modify demand" panel — the key
 * space the solver's demand table actually uses. `validatorCount` and
 * `stakeProxy` follow the CANONICAL counting rule (every user at the
 * exchange, keyed by device.exchange_pk — see buildCityStats), so an
 * override typed back at "Current" is a true no-op for the solver.
 */
export interface MetroDemand {
  /** Uppercased exchange code — the demandOverrides key. */
  metroCode: string;
  metroName: string;
  validatorCount: number;
  /** Leader-schedule slot sum (stake proxy) — display/sort only. */
  stakeProxy: number;
  /** Sum of member locations' demandScore (sorting only). */
  demandScore: number;
  /** Sum of member locations' linkCount (display only). */
  linkCount: number;
  locationCodes: string[];
}

export interface ParsedSnapshot {
  dzEpoch: number;
  solanaEpoch: number;
  contributors: Contributor[];
  locations: Location[];
  exchanges: Exchange[];
  cityDemands: CityDemand[];
  metroDemands: MetroDemand[];
  /**
   * True when the snapshot carries the fields the canonical demand builder
   * requires (start_us/end_us + metro_prices) — demand overrides are only
   * meaningful on canonical snapshots.
   */
  canonicalDemand: boolean;
  totalSlots: number;
  totalValidators: number;
  version: string;
  timestamp: string;
}
