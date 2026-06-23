/**
 * Canonical Foundation Shapley inputs fetcher.
 *
 * When DZ ships frozen per-epoch CSVs (private_links, devices,
 * public_links, demand) at a known URL, this module fetches and parses
 * them so the validation harness can run our Rust solver against the
 * exact inputs Foundation uses.
 *
 * Activation:
 *   1. Set `DZ_CANONICAL_INPUTS_URL` in env to e.g.
 *      "https://github.com/doublezerofoundation/shapley-inputs/raw/main/epoch-{N}/"
 *      (the {N} placeholder is replaced with the epoch number).
 *   2. The validation harness picks it up automatically; no code changes.
 *
 * Until then, every function returns `null` so callers can fall back to
 * the existing snapshot-derived inputs.
 */

import type { ShapleyInput } from "@/lib/types/shapley";
import { reportError } from "@/lib/observability";

export const CANONICAL_INPUTS_URL = process.env.DZ_CANONICAL_INPUTS_URL || "";

export const isCanonicalEnabled = !!CANONICAL_INPUTS_URL;

interface CsvRow {
  [k: string]: string;
}

/**
 * Tiny CSV parser. Handles quoted fields, embedded commas, and
 * Windows-style line endings. Doesn't try to be clever.
 */
function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: CsvRow = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cells[i] ?? "";
    }
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function fetchCsv(url: string): Promise<CsvRow[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`canonical fetch ${url} → HTTP ${res.status}`);
  const text = await res.text();
  return parseCsv(text);
}

/**
 * Fetch the four canonical CSVs for an epoch and assemble a ShapleyInput.
 *
 * The expected schema mirrors the upstream Python repo:
 *   - private_links.csv: Device1, Device2, Latency, Bandwidth, Uptime, Shared
 *   - devices.csv:       Device, Edge, Operator
 *   - public_links.csv:  City1, City2, Latency
 *   - demand.csv:        Start, End, Receivers, Traffic, Priority, Type, Multicast
 *
 * Returns null when the env var is unset OR when any of the four CSVs is
 * missing, so the validation harness can fall back to snapshot-derived
 * inputs without an exception.
 */
export async function fetchCanonicalInput(
  epoch: number,
): Promise<ShapleyInput | null> {
  if (!isCanonicalEnabled) return null;

  const base = CANONICAL_INPUTS_URL.replace("{N}", String(epoch)).replace(
    /\/$/,
    "",
  );

  let priv: CsvRow[];
  let devs: CsvRow[];
  let pub: CsvRow[];
  let dem: CsvRow[];
  try {
    [priv, devs, pub, dem] = await Promise.all([
      fetchCsv(`${base}/private_links.csv`),
      fetchCsv(`${base}/devices.csv`),
      fetchCsv(`${base}/public_links.csv`),
      fetchCsv(`${base}/demand.csv`),
    ]);
  } catch (err) {
    // Returning null causes the caller to fall back to snapshot-derived
    // inputs (the route stamps `inputSource: "snapshot-heuristic"` so
    // the fallback is visible in the response shape). Log the failure
    // so the missing canonical feed surfaces in observability — silent
    // degradation rule (#19).
    reportError(err, {
      source: "lib/utils/canonical-inputs",
      extras: { epoch, base },
    });
    return null;
  }

  const private_links = priv.map((r) => ({
    device1: r.Device1,
    device2: r.Device2,
    latency: parseFloat(r.Latency),
    bandwidth: parseFloat(r.Bandwidth),
    uptime: parseFloat(r.Uptime || "1.0"),
    shared: r.Shared && r.Shared !== "" ? parseInt(r.Shared, 10) : null,
  }));

  const devices = devs.map((r) => ({
    device: r.Device,
    edge: parseInt(r.Edge || "0", 10),
    operator: r.Operator,
  }));

  const public_links = pub.map((r) => ({
    city1: r.City1,
    city2: r.City2,
    latency: parseFloat(r.Latency),
  }));

  const demands = dem.map((r) => ({
    start: r.Start,
    end: r.End,
    receivers: parseInt(r.Receivers, 10),
    traffic: parseFloat(r.Traffic),
    priority: parseFloat(r.Priority),
    type: parseInt(r.Type, 10),
    multicast:
      r.Multicast === "true" ||
      r.Multicast === "True" ||
      r.Multicast === "1",
  }));

  return {
    private_links,
    devices,
    public_links,
    demands,
    operator_uptime: 0.98,
    contiguity_bonus: 5.0,
    demand_multiplier: 1.0,
  };
}
