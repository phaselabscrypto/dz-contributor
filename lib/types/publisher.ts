// Raw response from https://data.malbeclabs.com/api/dz/publisher-check
export interface PublisherCheckResponse {
  epoch: number;
  total_network_stake: number;
  publishers: Publisher[];
}

export interface Publisher {
  publisher_ip: string;
  client_ip: string;
  node_pubkey: string;
  vote_pubkey: string;
  dz_user_pubkey: string;
  dz_device_code: string;
  dz_metro_code: string;
  activated_stake: number;
  multicast_connected: boolean;
  publishing_leader_shreds: boolean;
  publishing_retransmitted: boolean;
  leader_slots: number;
  total_slots: number;
  total_unique_shreds: number;
  slots_needing_repair: number;
  validator_client: string;
  validator_version: string;
  validator_name: string;
  validator_version_ok: boolean;
  is_backup: boolean;
}

// Enriched type for UI display
export interface ValidatorRewardProjection {
  nodePubkey: string;
  votePubkey: string;
  validatorName: string;
  activatedStake: number;
  stakeSharePercent: number;
  publishingLeaderShreds: boolean;
  leaderSlots: number;
  totalSlots: number;
  dzMetroCode: string;
  dzDeviceCode: string;
  validatorClient: string;
  validatorVersion: string;
  isBackup: boolean;
  multicastConnected: boolean;
  /** Contributor code for the device this validator runs on, joined from
   * live topology when available. Undefined if no join could be made. */
  contributorCode?: string;
  projectedRewardPerEpochSol: number;
  projectedRewardMonthlySol: number;
  projectedRewardYearlySol: number;
}

export interface ValidatorRewardsSummary {
  epoch: number;
  totalNetworkStake: number;
  publishingValidatorCount: number;
  totalPublishingStake: number;
  projectedValidatorPoolPerEpochSol: number;
  validators: ValidatorRewardProjection[];
}
