// Types matching the DZ network-shapley-rs algorithm input/output format

export interface ShapleyDevice {
  device: string;     // device id, format `CITY##` (e.g., NYC01)
  edge: number;       // edge bandwidth in Mbps (sum of physical interfaces; falls back to 10_000)
  operator: string;   // operator pubkey (contributor.owner) — canonical identity
}

export interface ShapleyPrivateLink {
  device1: string;    // device id of endpoint A (e.g., NYC01)
  device2: string;    // device id of endpoint Z
  latency: number;    // milliseconds (canonical: p95 of valid samples)
  bandwidth: number;  // Mbps (canonical: link.bandwidth // BPS_TO_MBPS)
  uptime: number;     // 0-1 (canonical: valid_samples / total_samples)
  shared: number | null;
}

export interface ShapleyPublicLink {
  city1: string;      // metro code (3-letter)
  city2: string;      // metro code (3-letter)
  latency: number;    // milliseconds
}

export interface ShapleyDemand {
  start: string;      // metro code
  end: string;        // metro code
  receivers: number;
  traffic: number;
  priority: number;
  type: number;
  multicast: boolean;
}

export interface ShapleyInput {
  devices: ShapleyDevice[];
  private_links: ShapleyPrivateLink[];
  public_links: ShapleyPublicLink[];
  demands: ShapleyDemand[];
  operator_uptime: number;
  contiguity_bonus: number;
  demand_multiplier: number;
  /**
   * Normalized per-source-city aggregation weights (metro code → weight,
   * summing to 1.0), from the leader-schedule stake share. Mirrors DZ
   * `ShapleyInputs.city_weights` (calculator/input.rs); consumed by the Rust
   * service's per-city Shapley aggregation. Snake_case to match the rest of
   * this wire type (`private_links`, `operator_uptime`). Only the canonical
   * builder populates it; the reward path rejects inputs that omit it.
   */
  city_weights?: Record<string, number>;
}

export interface ShapleyOperatorValue {
  value: number;
  share: number; // 0-1 normalized
}

export type ShapleyOutput = Record<string, ShapleyOperatorValue>;

// Simulation types

export interface SimulateRequest {
  epoch: number;
  contributorCode: string;
  removeLinks: string[];
  addLinks: Array<{
    cityA: string;
    cityZ: string;
    bandwidthGbps?: number;
    latencyMs?: number;
  }>;
  demandOverrides?: Record<string, number>;
}

export interface SimulateContributorResult {
  code: string;
  beforeShare: number;
  afterShare: number;
}

export interface SimulateResponse {
  epoch: number;
  contributorCode: string;
  before: { share: number; value: number };
  after: { share: number; value: number };
  delta: { share: number };
  allContributors: SimulateContributorResult[];
}

export interface ShapleyResponse {
  epoch: number;
  method: string;
  operatorCount: number;
  values: ShapleyOutput;
  inputSummary: {
    deviceCount: number;
    privateLinkCount: number;
    publicLinkCount: number;
    demandCount: number;
  };
}
