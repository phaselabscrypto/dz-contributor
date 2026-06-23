import { LAMPORTS_PER_SOL } from "@/lib/constants/config";

export function formatSol(lamports: number, decimals = 2): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  return sol.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatSolFromSol(sol: number, decimals = 2): string {
  return sol.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Convert a SOL-equivalent amount to 2Z using a live conversion rate.
 * `twoZPerSol` is sourced from Jupiter (USD-price ratio of SOL/2Z). Pass 0 or
 * undefined to fall back to a 1:1 estimate (caller should label accordingly).
 */
export function solTo2Z(sol: number, twoZPerSol: number | undefined): number {
  if (!twoZPerSol || !Number.isFinite(twoZPerSol) || twoZPerSol <= 0) {
    return sol;
  }
  return sol * twoZPerSol;
}

/**
 * Format a 2Z amount. The input is already in 2Z units — convert via
 * `solTo2Z` first if you have a SOL-equivalent value.
 */
export function format2Z(value: number, decimals = 0): string {
  if (Math.abs(value) >= 1_000_000) {
    return (value / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + "M";
  }
  if (Math.abs(value) >= 10_000) {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  }
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format USD price (e.g., "$0.0818"). */
export function formatUsd(value: number, decimals = 4): string {
  return "$" + value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatNumber(n: number, decimals = 0): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPercent(ratio: number, decimals = 2): string {
  return (ratio * 100).toFixed(decimals) + "%";
}

export function formatLatencyMs(ns: number): string {
  const ms = ns / 1_000_000;
  if (ms < 1) return "<1ms";
  return ms.toFixed(1) + "ms";
}

export function formatBandwidth(gbps: number): string {
  if (gbps >= 1) return gbps.toFixed(0) + " Gbps";
  return (gbps * 1000).toFixed(0) + " Mbps";
}

/**
 * Format raw bits-per-second with an auto-scaling unit suffix.
 * Used by every page that displays link bandwidths — prefer this over
 * inline `fmtBps` duplicates so format changes (e.g. Pbps when we get
 * there, or a decimal-precision sweep) land in one place.
 */
export function fmtBps(bps: number): string {
  if (bps >= 1e12) return `${(bps / 1e12).toFixed(1)} Tbps`;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(0)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(0)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kbps`;
  return `${bps} bps`;
}

export function shortenPubkey(pubkey: string, chars = 4): string {
  if (pubkey.length <= chars * 2 + 3) return pubkey;
  return pubkey.slice(0, chars) + "..." + pubkey.slice(-chars);
}
