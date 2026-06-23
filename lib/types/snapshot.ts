// Raw S3 snapshot structure — all serviceability collections are dicts keyed by pubkey

export interface RawSnapshot {
  dz_epoch: number;
  solana_epoch: number;
  fetch_data: {
    dz_serviceability: {
      contributors: Record<string, RawContributor>;
      devices: Record<string, RawDevice>;
      links: Record<string, RawLink>;
      locations: Record<string, RawLocation>;
      exchanges: Record<string, RawExchange>;
      users: Record<string, RawUser>;
    };
    dz_telemetry: {
      device_latency_samples: RawDeviceLatencySample[];
    };
    dz_internet: {
      internet_latency_samples: RawInternetLatencySample[];
    };
    /** Epoch window microseconds — used to clip telemetry to the canonical window. */
    start_us?: number;
    end_us?: number;
    /** exchange_pk → USDC price (integer dollars). */
    metro_prices?: Record<string, number>;
  };
  leader_schedule: {
    solana_epoch: number;
    schedule_map: Record<string, number>; // validator_pubkey → slot_count
  };
  metadata: {
    created_at: string;
    network: string;
    exchanges_count: number;
    locations_count: number;
    devices_count: number;
    internet_samples_count: number;
    device_samples_count: number;
  };
}

export interface RawContributor {
  account_type: string;
  status: string;
  code: string;
  reference_count: number;
  ops_manager_pk: string;
  /** Canonical operator identity used by Shapley input. Pubkey of the owner wallet. */
  owner?: string;
}

export interface RawDevice {
  account_type: string;
  location_pk: string;
  exchange_pk: string;
  device_type: string;
  contributor_pk: string;
  device_health: string;
  max_users: number;
  status: string;
  code: string;
  users_count: number;
  /**
   * Physical/loopback interface entries. Each entry is { V1: {...} } or
   * { V2: {...} } depending on the snapshot epoch. V2 added a `bandwidth`
   * field; V1 doesn't carry bandwidth so we fall back to a default in the
   * canonical builder.
   */
  interfaces?: Array<{
    V1?: RawDeviceInterface;
    V2?: RawDeviceInterface;
  }>;
}

export interface RawDeviceInterface {
  status: string;
  name: string;
  interface_type: string; // "Physical" | "Loopback" | ...
  loopback_type?: string;
  vlan_id?: number;
  ip_net?: string;
  /** Present on V2 entries only. bps. */
  bandwidth?: number;
}

export interface RawLink {
  account_type: string;
  side_a_pk: string;
  side_z_pk: string;
  link_type: string;
  bandwidth: number;
  delay_ns: number;
  jitter_ns: number;
  contributor_pk: string;
  link_health: string;
  status: string;
  code: string;
  /** Operator-declared floor on link latency in ns; canonical input takes max(p95, 0.95×override). */
  delay_override_ns?: number;
}

export interface RawLocation {
  account_type: string;
  lat: number;
  lng: number;
  code: string;
  name: string;
  country: string;
  status: string;
  reference_count: number;
}

export interface RawExchange {
  account_type: string;
  lat: number;
  lng: number;
  code: string;
  name: string;
  status: string;
  reference_count: number;
  device1_pk: string;
  device2_pk: string;
}

export interface RawInternetLatencySample {
  pubkey: string;
  epoch: number;
  data_provider_name: string;
  oracle_agent_pk: string;
  origin_exchange_pk: string;
  target_exchange_pk: string;
  sampling_interval_us: number;
  start_timestamp_us: number;
  samples: number[]; // latency values in microseconds
  sample_count?: number;
}

/**
 * Per-link device latency record. Many records per link (one per oracle agent
 * direction). Canonical builder pools all `samples` arrays for a link and
 * computes p95 of the non-zero values.
 */
export interface RawDeviceLatencySample {
  pubkey: string;
  epoch: number;
  origin_device_pk: string;
  target_device_pk: string;
  link_pk: string;
  origin_device_agent_pk?: string;
  sampling_interval_us: number;
  start_timestamp_us: number;
  samples: number[]; // microseconds
  sample_count?: number;
}

export interface RawUser {
  account_type: string;
  device_pk: string;
  validator_pubkey: string;
  status: string;
  /** "IBRL" | "IBRLWithAllocatedIP" | "Multicast" — only Multicast users count as Shred subscribers. */
  user_type: string;
  /** Comma-joined pubkey list. Empty string means "not a publisher" → counts as Shred receiver. */
  publishers?: string;
  subscribers?: string;
}
