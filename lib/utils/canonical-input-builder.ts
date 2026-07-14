/**
 * Canonical Shapley input builder.
 *
 * TypeScript port of DZ Foundation's `build_shapley_inputs.py` reference
 * implementation (which is itself verified byte-for-byte against the
 * `doublezero-offchain contributor-rewards v0.5.3` Rust binary on mainnet
 * epoch 149).
 *
 * Produces the four canonical tables (devices, private_links, public_links,
 * demands) that feed the `network-shapley-rs` LP solver. When paired with
 * the canonical Rust solver, the resulting Shapley values are bit-comparable
 * to Foundation output.
 *
 * Citations in comments below reference the original Rust crate paths under
 * `crates/contributor-rewards/src/`.
 */

import type {
  RawSnapshot,
  RawDevice,
  RawDeviceInterface,
} from "@/lib/types/snapshot";
import type { ShapleyInput } from "@/lib/types/shapley";
import { CANONICAL_SHAPLEY_PARAMS } from "@/lib/constants/config";

// Constants — calculator/constants.rs
const BPS_TO_MBPS = 1_000_000;
const FALLBACK_EDGE_MBPS = 10_000.0;

// DemandSettings defaults — settings/mod.rs:80
const DEMAND_TRAFFIC = 0.15;
// IBRL/unicast demand priority and the public-latency multiplier are the two
// knobs that define DoubleZero's CURRENT (post-#369) reward methodology. They
// are now config-driven — see `CANONICAL_SHAPLEY_PARAMS` in
// `lib/constants/config.ts` (defaults 20.0 / 1.25, mirroring DZ's shipped
// example.config.toml, env-overridable). Epoch-149 used 0.0 / 1.0; reproduce a
// pre-#369 epoch by passing `buildCanonicalShapleyInput(snap, { ibrlPriority: 0,
// publicLatencyMultiplier: 1 })`. Parity-verified vs DZ `export shapley` at
// epoch 184 (max |Δ| = 2.35e-15).
const DEMAND_KIND_IBRL = 1;
const DEMAND_KIND_SHRED = 2;

// network-shapley-rs ShapleyInput tuning defaults — match DoubleZero's deployed
// `[shapley]` config on mainnet epoch 149 (contributor-rewards/v0.5.3
// example.config.toml), confirmed by running DZ's own `export shapley` on the
// epoch-149 snapshot.
// NOTE: `demand_multiplier` is output-INVARIANT for the reward proportions —
// the engine normalizes it out (DZ's export is byte-identical at 1.0 and 1.2).
// It's kept at DZ's value (1.2) purely for config faithfulness. The real
// epoch-149 divergence was NOT this; it was the engine fork's quadratic uptime
// penalty vs DZ v0.5.0's linear `bandwidth * uptime` (see docs/simulate-dz-parity-FINDINGS.md).
const OPERATOR_UPTIME = 0.98;
const CONTIGUITY_BONUS = 5.0;
const DEMAND_MULTIPLIER = 1.2;

// ─────────────────────────────────────────────────────────────────────────────
// Base58 → raw bytes for stable pubkey ordering.
//
// Rust's `Pubkey` Ord is on the underlying 32 bytes, which is NOT the same
// as base58 string lexicographic order. The canonical Rust builder sorts
// devices stably by `contributor_pk` raw bytes so that one operator's
// devices group together. We need to match that ordering exactly or device
// IDs (CITY01, CITY02, ...) drift.
// ─────────────────────────────────────────────────────────────────────────────

const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) {
  B58_INDEX[B58_ALPHABET[i]] = i;
}

/**
 * Decode a base58 pubkey to its raw byte sequence. Returns a Uint8Array
 * whose lexicographic order matches Rust's `Pubkey` Ord.
 *
 * Uses BigInt arithmetic because pubkeys are 32 bytes and exceed
 * `Number.MAX_SAFE_INTEGER`.
 */
export function pubkeyBytes(pk: string): Uint8Array {
  let n = 0n;
  for (const ch of pk) {
    const v = B58_INDEX[ch];
    if (v === undefined) {
      throw new Error(`invalid base58 char in pubkey: ${ch}`);
    }
    n = n * 58n + BigInt(v);
  }
  // Leading '1' chars in base58 represent leading zero bytes.
  let pad = 0;
  for (const ch of pk) {
    if (ch === "1") pad++;
    else break;
  }
  // Convert bigint to big-endian bytes.
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bodyLen = n === 0n ? 0 : hex.length / 2;
  const out = new Uint8Array(pad + bodyLen);
  for (let i = 0; i < bodyLen; i++) {
    out[pad + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// R-default quantile (type=7) — linear interpolation. Mirrors
// `processor/util.rs::quantile_r_type7`. Input must be sorted ascending.
// ─────────────────────────────────────────────────────────────────────────────

export function quantileR7(xsSorted: number[], p: number): number {
  const n = xsSorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * p;
  const i = Math.floor(h);
  if (i >= n - 1) return xsSorted[n - 1];
  return xsSorted[i] + (h - i) * (xsSorted[i + 1] - xsSorted[i]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Devices — handler.rs:104-214
// ─────────────────────────────────────────────────────────────────────────────

interface DeviceRowInternal {
  device: string;
  edge: number;
  operator: string;
}

interface PreparedDevice {
  pk: string;
  contributor_pk: string;
  city: string;
  /**
   * Operator identity. We use the contributor's SHORT CODE (e.g. "jump_"),
   * not the owner wallet pubkey, because the route, modifier, and UI all key
   * everything by short code (the client sends `contributorCode`). The LP and
   * the resulting Shapley values are invariant to the operator *label* — only
   * the keys of the output map change — so emitting the code instead of the
   * pubkey keeps the values bit-comparable to Foundation output while fixing
   * the silent key mismatch (results read as 0% / link edits became no-ops).
   */
  operator: string;
  iface_bps: number;
  contribBytes: Uint8Array;
}

function physicalInterfaceBandwidth(d: RawDevice): number {
  let total = 0;
  for (const iface of d.interfaces ?? []) {
    const variant: RawDeviceInterface | undefined = iface.V2 ?? iface.V1;
    if (!variant) continue;
    if (variant.interface_type !== "Physical") continue;
    // Only V2 carries `bandwidth`; V1 contributes 0 and we fall back later.
    total += variant.bandwidth ?? 0;
  }
  return total;
}

function buildDevices(snap: RawSnapshot): {
  rows: DeviceRowInternal[];
  deviceId: Map<string, string>;
} {
  const serv = snap.fetch_data.dz_serviceability;

  // The reference loads via serde_json which (without preserve_order)
  // routes through BTreeMap → base58-string-sorted iteration. Replicate
  // that with a sorted key list.
  const sortedDeviceKeys = Object.keys(serv.devices).slice().sort();

  const prepared: PreparedDevice[] = [];
  for (const pk of sortedDeviceKeys) {
    const d = serv.devices[pk];
    const contrib = serv.contributors[d.contributor_pk];
    const exchange = serv.exchanges[d.exchange_pk];
    if (!contrib || !exchange) continue;
    // The contributor short code is the operator identity used everywhere
    // downstream (route lookups, modifier filters, UI). See PreparedDevice.
    if (!contrib.code) continue;

    const iface_bps = physicalInterfaceBandwidth(d);
    prepared.push({
      pk,
      contributor_pk: d.contributor_pk,
      city: exchange.code.toUpperCase(),
      operator: contrib.code,
      iface_bps,
      contribBytes: pubkeyBytes(d.contributor_pk),
    });
  }

  // Stable sort by contributor_pk RAW BYTES, not base58 string. Array.sort
  // in modern V8 (TimSort) is stable so equal-key entries preserve their
  // base58-sorted order from above.
  prepared.sort((a, b) => cmpBytes(a.contribBytes, b.contribBytes));

  const counts = new Map<string, number>();
  const deviceId = new Map<string, string>();
  const rows: DeviceRowInternal[] = [];

  for (const p of prepared) {
    const c = (counts.get(p.city) ?? 0) + 1;
    counts.set(p.city, c);
    const sid = `${p.city}${c.toString().padStart(2, "0")}`;
    deviceId.set(p.pk, sid);
    const edge_mbps =
      p.iface_bps > 0 ? p.iface_bps / BPS_TO_MBPS : FALLBACK_EDGE_MBPS;
    rows.push({ device: sid, edge: Math.trunc(edge_mbps), operator: p.operator });
  }
  return { rows, deviceId };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Private links — handler.rs:345-466
// ─────────────────────────────────────────────────────────────────────────────

function buildPrivateLinks(
  snap: RawSnapshot,
  deviceId: Map<string, string>,
): ShapleyInput["private_links"] {
  const serv = snap.fetch_data.dz_serviceability;
  const tel = snap.fetch_data.dz_telemetry.device_latency_samples ?? [];

  // Pool all directional samples per link.
  const samplesByLink = new Map<string, number[][]>();
  for (const rec of tel) {
    if (!rec.link_pk) continue;
    let arr = samplesByLink.get(rec.link_pk);
    if (!arr) {
      arr = [];
      samplesByLink.set(rec.link_pk, arr);
    }
    arr.push(rec.samples);
  }

  const rows: ShapleyInput["private_links"] = [];
  for (const [linkPk, link] of Object.entries(serv.links)) {
    if (link.status !== "Activated") continue;
    const a = serv.devices[link.side_a_pk];
    const z = serv.devices[link.side_z_pk];
    if (!a || !z) continue;
    if (a.status !== "Activated" || z.status !== "Activated") continue;
    const d1 = deviceId.get(link.side_a_pk);
    const d2 = deviceId.get(link.side_z_pk);
    if (!d1 || !d2) continue;

    let total = 0;
    const valid: number[] = [];
    for (const samples of samplesByLink.get(linkPk) ?? []) {
      for (const s of samples) {
        total += 1;
        if (s > 1e-10) valid.push(s);
      }
    }
    // Need more than 20 valid samples for the link to be considered usable.
    if (valid.length <= 20) continue;

    valid.sort((x, y) => x - y);
    const overrideFloorUs = (0.95 * (link.delay_override_ns ?? 0)) / 1000;
    const latencyUs = Math.max(quantileR7(valid, 0.95), overrideFloorUs);

    rows.push({
      device1: d1,
      device2: d2,
      latency: latencyUs / 1000.0, // µs → ms
      bandwidth: Math.floor(link.bandwidth / BPS_TO_MBPS),
      uptime: valid.length / total,
      shared: null,
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Public links — handler.rs:225-343 + processor/internet.rs
// ─────────────────────────────────────────────────────────────────────────────

function buildPublicLinks(
  snap: RawSnapshot,
  latencyMultiplier: number,
): ShapleyInput["public_links"] {
  const fd = snap.fetch_data;
  const serv = fd.dz_serviceability;
  const startUs = fd.start_us;
  const endUs = fd.end_us;

  if (startUs == null || endUs == null) {
    // Snapshot doesn't carry the canonical epoch window — we can't replicate
    // the reference's window-clipping. Caller should fall back.
    return [];
  }

  const exchangeCity = new Map<string, string>();
  for (const [pk, ex] of Object.entries(serv.exchanges)) {
    exchangeCity.set(pk, ex.code.toUpperCase());
  }

  // Group samples by (origin_pk, target_pk, provider), excluding ripeatlas.
  type GroupKey = string;
  const groups = new Map<GroupKey, typeof fd.dz_internet.internet_latency_samples>();
  for (const rec of fd.dz_internet.internet_latency_samples) {
    if (rec.data_provider_name === "ripeatlas") continue;
    const key = `${rec.origin_exchange_pk}|${rec.target_exchange_pk}|${rec.data_provider_name}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(rec);
  }

  // For each circuit, compute p95(µs) from non-zero samples within the
  // epoch's [start_us, end_us] window. Then average circuit p95s per
  // normalized city pair and convert to ms.
  const pairLatencies = new Map<string, number[]>();
  for (const [key, recs] of groups) {
    const [oPk, tPk] = key.split("|");
    const cO = exchangeCity.get(oPk);
    const cT = exchangeCity.get(tPk);
    if (!cO || !cT) continue;

    const valid: number[] = [];
    for (const rec of recs) {
      const ts = rec.start_timestamp_us;
      const dt = rec.sampling_interval_us;
      const sc = rec.sample_count ?? rec.samples.length;
      const endTs = ts + sc * dt;
      const i0 =
        startUs > ts ? Math.max(0, Math.floor((startUs - ts) / dt)) : 0;
      const i1 =
        endUs < endTs
          ? Math.min(rec.samples.length, Math.floor((endUs - ts) / dt))
          : rec.samples.length;
      for (let i = i0; i < i1; i++) {
        const s = rec.samples[i];
        if (s > 1e-10) valid.push(s);
      }
    }
    if (valid.length === 0) continue;
    valid.sort((a, b) => a - b);
    const p95us = quantileR7(valid, 0.95);
    const pair = cO <= cT ? `${cO}|${cT}` : `${cT}|${cO}`;
    let list = pairLatencies.get(pair);
    if (!list) {
      list = [];
      pairLatencies.set(pair, list);
    }
    list.push(p95us / 1000.0); // µs → ms
  }

  const rows: ShapleyInput["public_links"] = [];
  for (const [pair, ls] of pairLatencies) {
    const [city1, city2] = pair.split("|");
    const avg = ls.reduce((s, x) => s + x, 0) / ls.length;
    // Public-internet latency ×multiplier (DZ `[input] public_latency_multiplier`,
    // an M/M/1 loaded-vs-baseline model; 1.0 = epoch-149 raw pass-through).
    rows.push({ city1, city2, latency: avg * latencyMultiplier });
  }
  rows.sort((a, b) =>
    a.city1 === b.city1 ? a.city2.localeCompare(b.city2) : a.city1.localeCompare(b.city1),
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) City stats + demands + city weights — demand.rs:119-353, util.rs:19-36
// ─────────────────────────────────────────────────────────────────────────────

interface CityStats {
  validators: number;
  /**
   * Sum of leader-schedule slot counts for this city's validators — DZ's
   * `total_stake_proxy` (demand.rs:151-181). A stake proxy (how often the
   * city leads), NOT lamports. Drives the cross-city aggregation weight; the
   * economic (metro-price) signal rides the Shred demand `priority` instead.
   */
  stakeProxy: number;
  subscribers: number;
  price: number;
}

/**
 * Build per-city statistics — TypeScript port of DZ `build_city_stats`
 * (`ingestor/demand.rs:119-283`). Cities are keyed by `exchange.code`
 * uppercased, which is exactly the key used for `demand.start`/`demand.end`
 * (mainnet) — so the resulting `cityWeights` line up 1:1 with the source
 * cities the per-city Shapley aggregation iterates over.
 */
function buildCityStats(snap: RawSnapshot): Map<string, CityStats> {
  const fd = snap.fetch_data;
  const serv = fd.dz_serviceability;
  const metroPrices = fd.metro_prices ?? {};
  const scheduleMap = snap.leader_schedule?.schedule_map ?? {};

  const cs = new Map<string, CityStats>();
  const stats = (city: string): CityStats => {
    let s = cs.get(city);
    if (!s) {
      s = { validators: 0, stakeProxy: 0, subscribers: 0, price: 0 };
      cs.set(city, s);
    }
    return s;
  };

  // Validators + stake proxy: every user whose device has a resolvable
  // location AND exchange. stake_proxy = leader-schedule slot count for the
  // user's validator_pubkey, defaulting to 0 when absent (demand.rs:151-155).
  // DZ does NOT special-case the all-1s SystemProgram pubkey — it simply isn't
  // in the leader schedule, so it contributes 0; we match that exactly.
  for (const u of Object.values(serv.users)) {
    const d = serv.devices[u.device_pk];
    if (!d) continue;
    if (!serv.locations[d.location_pk] || !serv.exchanges[d.exchange_pk]) {
      continue;
    }
    const s = stats(serv.exchanges[d.exchange_pk].code.toUpperCase());
    s.validators += 1;
    s.stakeProxy += scheduleMap[u.validator_pubkey] ?? 0;
  }

  // Subscribers: live Multicast users that aren't publishers
  // (rust `is_publisher() = !publishers.is_empty()`).
  for (const u of Object.values(serv.users)) {
    if (u.user_type !== "Multicast") continue;
    if (u.status === "Rejected" || u.status === "Banned" || u.status === "PendingBan") {
      continue;
    }
    if (u.publishers && u.publishers.length > 0) continue;
    const d = serv.devices[u.device_pk];
    if (!d) continue;
    if (!serv.contributors[d.contributor_pk]) continue;
    if (!serv.exchanges[d.exchange_pk]) continue;
    stats(serv.exchanges[d.exchange_pk].code.toUpperCase()).subscribers += 1;
  }

  // City prices (USDC dollars) keyed by exchange_pk.
  for (const [exPk, price] of Object.entries(metroPrices)) {
    const ex = serv.exchanges[exPk];
    if (!ex) continue;
    const c = ex.code.toUpperCase();
    const s = cs.get(c);
    if (s) s.price = Math.trunc(price);
  }

  return cs;
}

/**
 * Normalized per-city aggregation weights — TypeScript port of DZ
 * `calculate_city_weights` (`calculator/util.rs:19-36`). Weight =
 * city.stakeProxy / Σ stakeProxy, summing to 1.0; falls back to uniform
 * 1/n ONLY when the global stake total is 0. Keyed identically to
 * `buildCityStats` (exchange code, uppercased) so lookups by `demand.start`
 * resolve.
 */
export function calculateCityWeights(
  cs: Map<string, CityStats>,
): Record<string, number> {
  let total = 0;
  for (const s of cs.values()) total += s.stakeProxy;
  const n = cs.size;
  const weights: Record<string, number> = {};
  for (const [city, s] of cs) {
    weights[city] = total > 0 ? s.stakeProxy / total : n > 0 ? 1 / n : 0;
  }
  return weights;
}

/**
 * Generate IBRL + Shred demand rows from city stats — TypeScript port of DZ
 * `generate` (`ingestor/demand.rs:286-353`).
 */
function buildDemands(
  cs: Map<string, CityStats>,
  ibrlPriority: number,
): ShapleyInput["demands"] {
  const senders: Array<[string, CityStats]> = [];
  const receiversShred: Array<[string, CityStats]> = [];
  for (const [c, s] of cs) {
    if (s.validators > 0) senders.push([c, s]);
    if (s.subscribers > 0 && s.price > 0) receiversShred.push([c, s]);
  }

  const rows: ShapleyInput["demands"] = [];

  // IBRL: validator → validator, exclude self-pair.
  for (const [start] of senders) {
    for (const [end, endS] of senders) {
      if (start === end) continue;
      rows.push({
        start,
        end,
        receivers: endS.validators,
        traffic: DEMAND_TRAFFIC,
        priority: ibrlPriority,
        type: DEMAND_KIND_IBRL,
        multicast: false,
      });
    }
  }

  // Shred: validator → subscriber-metro, includes intra-city (start === end).
  for (const [start] of senders) {
    for (const [end, endS] of receiversShred) {
      rows.push({
        start,
        end,
        receivers: endS.subscribers,
        traffic: DEMAND_TRAFFIC,
        priority: endS.price,
        type: DEMAND_KIND_SHRED,
        multicast: true,
      });
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface CanonicalBuildResult {
  input: ShapleyInput;
  /** True if all canonical fields were present and we produced bit-comparable inputs. */
  canonical: boolean;
  /** Why canonical=false, if applicable. */
  reason?: string;
}

/**
 * Optional per-call override of the two DZ-current reward params. Defaults come
 * from `CANONICAL_SHAPLEY_PARAMS` (config/env). Use this to reproduce a specific
 * historical epoch's params (e.g. epoch 149: `{ ibrlPriority: 0, publicLatencyMultiplier: 1 }`).
 */
export interface CanonicalParamsOverride {
  ibrlPriority?: number;
  publicLatencyMultiplier?: number;
}

/**
 * Build canonical Shapley input tables from a snapshot.
 *
 * Returns `canonical: false` (with `reason`) when the snapshot doesn't carry
 * every field the reference builder needs (older snapshots lack
 * `start_us`/`end_us` or `metro_prices`).
 */
export function buildCanonicalShapleyInput(
  snap: RawSnapshot,
  override?: CanonicalParamsOverride,
): CanonicalBuildResult {
  const ibrlPriority =
    override?.ibrlPriority ?? CANONICAL_SHAPLEY_PARAMS.ibrlPriority;
  const publicLatencyMultiplier =
    override?.publicLatencyMultiplier ??
    CANONICAL_SHAPLEY_PARAMS.publicLatencyMultiplier;

  const fd = snap.fetch_data;

  if (fd.start_us == null || fd.end_us == null) {
    return {
      input: emptyInput(),
      canonical: false,
      reason: "snapshot missing start_us/end_us epoch window",
    };
  }
  if (!fd.metro_prices || Object.keys(fd.metro_prices).length === 0) {
    return {
      input: emptyInput(),
      canonical: false,
      reason: "snapshot missing metro_prices",
    };
  }

  const { rows: devices, deviceId } = buildDevices(snap);
  const private_links = buildPrivateLinks(snap, deviceId);
  const public_links = buildPublicLinks(snap, publicLatencyMultiplier);
  // City stats drive BOTH the demand table and the cross-city aggregation
  // weights, so build them once and derive both — exactly as DZ derives
  // `generate(&city_stats)` and `calculate_city_weights(&city_stats)` from the
  // same `CityStats` (calculator/input.rs).
  const cityStats = buildCityStats(snap);
  const demands = buildDemands(cityStats, ibrlPriority);
  const city_weights = calculateCityWeights(cityStats);

  return {
    input: {
      devices,
      private_links,
      public_links,
      demands,
      operator_uptime: OPERATOR_UPTIME,
      contiguity_bonus: CONTIGUITY_BONUS,
      demand_multiplier: DEMAND_MULTIPLIER,
      city_weights,
    },
    canonical: true,
  };
}

function emptyInput(): ShapleyInput {
  return {
    devices: [],
    private_links: [],
    public_links: [],
    demands: [],
    operator_uptime: OPERATOR_UPTIME,
    contiguity_bonus: CONTIGUITY_BONUS,
    demand_multiplier: DEMAND_MULTIPLIER,
    city_weights: {},
  };
}
