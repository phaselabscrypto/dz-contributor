/**
 * Types for live network/economics data sourced from:
 *   https://data.malbeclabs.com/api/topology   (network topology)
 *   https://data.malbeclabs.com/api/stats      (network stats)
 *   https://data.malbeclabs.com/api/status     (link health + issues)
 *   https://doublezero.xyz/api/economic-hub    (real reward distribution)
 *
 * These supersede the older S3 snapshot pipeline for "what is the network now"
 * questions. The S3 snapshot remains the source for historical Shapley
 * simulation only.
 */

export interface LiveMetro {
  pk: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface LiveDevice {
  pk: string;
  code: string;
  status: string;
  deviceType: string;
  metroPk: string;
  metroCode: string;
  contributorPk: string;
  contributorCode: string;
  userCount: number;
  validatorCount: number;
  stakeSol: number;
  stakeShare: number;
}

export interface LiveLink {
  pk: string;
  code: string;
  status: string;
  linkType: string; // WAN | DZX | ...
  bandwidthBps: number;
  sideAPk: string;
  sideACode: string;
  sideAMetro: string;
  sideZPk: string;
  sideZCode: string;
  sideZMetro: string;
  contributorPk: string;
  contributorCode: string;
  latencyUs: number;
  jitterUs: number;
  lossPercent: number;
  inBps: number;
  outBps: number;
  committedRttNs: number;
}

export interface LiveValidator {
  votePubkey: string;
  nodePubkey: string;
  devicePk: string;
  latitude: number;
  longitude: number;
  city: string;
  country: string;
  stakeSol: number;
  stakeShare: number;
  commission: number;
  version: string;
}

export interface LiveContributor {
  code: string;
  pk: string;
  deviceCount: number;
  linkCount: number;
  totalStakeSol: number;
  validatorCount: number;
  totalBandwidthBps: number;
  metros: string[]; // metro codes
}

export interface LiveTopology {
  metros: LiveMetro[];
  devices: LiveDevice[];
  links: LiveLink[];
  validators: LiveValidator[];
  contributors: LiveContributor[];
  fetchedAt: number;
}

export interface LiveStats {
  validatorsOnDz: number;
  totalStakeSol: number;
  stakeSharePct: number; // % of Solana stake on DZ
  users: number;
  devices: number;
  links: number;
  contributors: number;
  metros: number;
  bandwidthBps: number;
  userInboundBps: number;
  fetchedAt: string;
}

export interface LiveLinkIssue {
  code: string;
  linkType: string;
  contributor: string;
  issue: string;
  value: number;
  threshold: number;
  sideAMetro: string;
  sideZMetro: string;
  since: string;
  isDown: boolean;
  bandwidthBps: number;
}

export interface LiveTopUtilLink {
  pk: string;
  code: string;
  linkType: string;
  contributor: string;
  bandwidthBps: number;
  inBps: number;
  outBps: number;
  utilizationIn: number;
  utilizationOut: number;
  sideAMetro: string;
  sideZMetro: string;
}

export interface LiveStatus {
  status: string;
  timestamp: string;
  network: LiveStats;
  linkHealth: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    disabled: number;
  };
  issues: LiveLinkIssue[];
  topUtilLinks: LiveTopUtilLink[];
}

/**
 * Real DZ reward distribution from the on-chain economic hub.
 * `reward_percentage` is each contributor's actual % of the contributor pool
 * across all distributed epochs.
 */
export interface EconomicHubContributor {
  name: string;
  wanLinks: number;
  dzxLinks: number;
  devices: number;
  bandwidthBps: number;
  totalFiberLength: number;
  rewardPercentage: number; // already in %, not 0-1
}

export interface EconomicHub {
  epochs: number[];
  currentEpoch: number;
  totalSolDebt: number;
  totalSolDebtUsd: number;
  total2ZDebt: number;
  total2ZDebtUsd: number;
  totalDistributed2Z: number;
  totalDistributed2ZUsd: number;
  burned2Z: number;
  burned2ZUsd: number;
  totalWanLinks: number;
  totalDzxLinks: number;
  totalFiberLength: number;
  totalBandwidthBps: number;
  contributors: EconomicHubContributor[];
  updatedAt: string;
}
