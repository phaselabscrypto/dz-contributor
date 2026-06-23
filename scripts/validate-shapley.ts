#!/usr/bin/env node
/**
 * Self-validation harness for our Shapley pipeline.
 *
 * Hits /api/shapley?epoch=N for a range of epochs and produces a
 * `validation-report.md` with:
 *   1. Per-epoch operator shares from our solver
 *   2. All-time payout shares from economic-hub for the same operators
 *   3. Drift between the two (our solver vs Foundation distribution)
 *   4. Cross-epoch stability — operator shares shouldn't swing wildly
 *      between adjacent epochs unless topology changed materially
 *   5. Invariants — shares sum to ~1, every operator appears, etc.
 *
 * Usage:
 *   BASE_URL=https://dz-contributor.vercel.app \
 *   EPOCHS=120,121,122,123 \
 *     npx tsx scripts/validate-shapley.ts
 *
 * Or against local dev:
 *   npm run dev &
 *   BASE_URL=http://localhost:3000 npx tsx scripts/validate-shapley.ts
 *
 * Output: writes `validation-report.md` to repo root.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface ShapleyValue {
  value: number;
  share: number;
}

interface ShapleyResponse {
  epoch: number;
  method: string;
  /** "canonical-foundation" once DZ_CANONICAL_INPUTS_URL is wired */
  inputSource?:
    | "canonical-foundation"
    | "canonical-snapshot"
    | "snapshot-heuristic"
    | "snapshot-derived"; // legacy label for old cached responses
  operatorCount: number;
  values: Record<string, ShapleyValue>;
  inputSummary: {
    deviceCount: number;
    privateLinkCount: number;
    publicLinkCount: number;
    demandCount: number;
  };
}

interface EconomicHubContributor {
  name: string;
  rewardPercentage: number;
}

interface EconomicHub {
  epochs: number[];
  contributors: EconomicHubContributor[];
}

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const EPOCHS = (process.env.EPOCHS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));

// economic-hub names ↔ contributor codes (from lib/constants/config.ts)
const EH_NAME_TO_CODE: Record<string, string> = {
  JumpCrypto: "jump_",
  "Distributed Global Technologies": "dgt",
  Galaxy: "glxy",
  "Staking Facilities": "stakefac",
  "Cherry Servers": "cherry",
  RockawayX: "rox",
  "Infinite Fiber": "infiber",
  Teraswitch: "tsw",
  s3v: "s3v",
  "Cumberland/DRW": "cdrw",
  Laconic: "laconic",
  Latitude: "latitude",
  VELIA: "velia",
  Allnodes: "allnodes",
};

function ehNameToCode(name: string): string {
  return EH_NAME_TO_CODE[name] ?? name.toLowerCase().replace(/\s+/g, "");
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function discoverEpochs(): Promise<number[]> {
  if (EPOCHS.length > 0) return EPOCHS;
  // Fall back to the latest 4 epochs the discovery endpoint reports.
  const data = await getJson<{ latest: number; available: number[] }>(
    `${BASE_URL}/api/epochs`,
  );
  return data.available.slice(0, 4).sort((a, b) => a - b);
}

async function fetchShapley(epoch: number): Promise<ShapleyResponse> {
  return getJson<ShapleyResponse>(`${BASE_URL}/api/shapley?epoch=${epoch}`);
}

async function fetchEconomicHub(): Promise<EconomicHub | null> {
  try {
    return await getJson<EconomicHub>(`${BASE_URL}/api/live/economic-hub`);
  } catch (err) {
    console.warn(`economic-hub fetch failed: ${err}`);
    return null;
  }
}

function fmtPct(x: number, digits = 2): string {
  return (x * 100).toFixed(digits) + "%";
}
function fmtPp(x: number, digits = 2): string {
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(digits)}pp`;
}

interface OperatorTrack {
  code: string;
  perEpoch: Map<number, number>; // epoch → share (0-1)
  ehSharePct: number | null; // 0-100
}

async function main() {
  console.log(`Validating Shapley pipeline against ${BASE_URL}`);

  const epochs = await discoverEpochs();
  if (epochs.length === 0) {
    console.error("No epochs to validate. Set EPOCHS=N,N,N or fix /api/epochs.");
    process.exit(1);
  }
  console.log(`Epochs: ${epochs.join(", ")}`);

  const hub = await fetchEconomicHub();
  const hubByCode = new Map<string, number>();
  if (hub) {
    for (const c of hub.contributors) {
      hubByCode.set(ehNameToCode(c.name), c.rewardPercentage);
    }
  }

  const responses: ShapleyResponse[] = [];
  for (const ep of epochs) {
    process.stdout.write(`  fetching epoch ${ep}… `);
    try {
      const r = await fetchShapley(ep);
      console.log(`${r.method}, ${r.operatorCount} ops`);
      responses.push(r);
    } catch (err) {
      console.log(`FAILED (${err})`);
    }
  }

  if (responses.length === 0) {
    console.error("All epochs failed. Aborting.");
    process.exit(1);
  }

  // Build per-operator track across epochs
  const tracks = new Map<string, OperatorTrack>();
  for (const r of responses) {
    for (const [code, v] of Object.entries(r.values)) {
      let t = tracks.get(code);
      if (!t) {
        t = {
          code,
          perEpoch: new Map(),
          ehSharePct: hubByCode.get(code) ?? null,
        };
        tracks.set(code, t);
      }
      t.perEpoch.set(r.epoch, v.share);
    }
  }

  // Sort tracks by latest-epoch share desc
  const latestEp = responses[responses.length - 1].epoch;
  const sorted = [...tracks.values()].sort(
    (a, b) =>
      (b.perEpoch.get(latestEp) ?? 0) - (a.perEpoch.get(latestEp) ?? 0),
  );

  // Compute invariants per epoch
  const invariants = responses.map((r) => {
    const total = Object.values(r.values).reduce((s, v) => s + v.share, 0);
    return {
      epoch: r.epoch,
      method: r.method,
      operatorCount: r.operatorCount,
      shareSum: total,
      sumOk: Math.abs(total - 1) < 0.001,
      inputSummary: r.inputSummary,
    };
  });

  // Cross-epoch stability: max swing per operator between adjacent epochs
  const stability = sorted
    .map((t) => {
      let maxSwing = 0;
      let swingFrom = -1,
        swingTo = -1;
      for (let i = 1; i < responses.length; i++) {
        const a = t.perEpoch.get(responses[i - 1].epoch) ?? 0;
        const b = t.perEpoch.get(responses[i].epoch) ?? 0;
        const swing = Math.abs(b - a) * 100; // percentage points
        if (swing > maxSwing) {
          maxSwing = swing;
          swingFrom = responses[i - 1].epoch;
          swingTo = responses[i].epoch;
        }
      }
      return { code: t.code, maxSwing, swingFrom, swingTo };
    })
    .filter((s) => s.maxSwing > 0.5) // only flag swings >0.5pp
    .sort((a, b) => b.maxSwing - a.maxSwing);

  // Drift vs economic-hub all-time
  const drift = sorted
    .filter((t) => t.ehSharePct !== null)
    .map((t) => {
      const latestShare = (t.perEpoch.get(latestEp) ?? 0) * 100;
      const ehShare = t.ehSharePct!;
      return {
        code: t.code,
        latestSharePct: latestShare,
        ehSharePct: ehShare,
        deltaPp: latestShare - ehShare,
      };
    })
    .sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp));

  // Build markdown report
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push(`# Shapley validation report`);
  lines.push("");
  lines.push(`Generated: \`${now}\``);
  lines.push(`Source: \`${BASE_URL}\``);
  lines.push("");
  lines.push(`## Methods used`);
  lines.push("");
  const methods = new Set(responses.map((r) => r.method));
  for (const m of methods) {
    const note =
      m === "lp-multi-commodity-flow-rs"
        ? "✅ canonical Rust solver"
        : m === "local-ts-heuristic-DEV-ONLY"
        ? "⚠️ dev-only TS heuristic — SHAPLEY_SERVICE_URL unset"
        : m === "coalition-enumeration-v1-fallback"
        ? "⚠️ legacy fallback label — should not appear post-PR-22"
        : m;
    lines.push(`- \`${m}\` — ${note}`);
  }
  lines.push("");

  lines.push(`## Input sources`);
  lines.push("");
  const sources = new Set(
    responses.map((r) => r.inputSource ?? "snapshot-derived"),
  );
  for (const s of sources) {
    const note =
      s === "canonical-foundation"
        ? "✅ Foundation per-epoch CSVs (DZ_CANONICAL_INPUTS_URL set)"
        : s === "canonical-snapshot"
        ? "✅ canonical TS port — bit-comparable to DZ reference on epoch 149"
        : s === "snapshot-derived" || s === "snapshot-heuristic"
        ? "⚠️ heuristic fallback — snapshot missing canonical fields"
        : s;
    lines.push(`- \`${s}\` — ${note}`);
  }
  lines.push("");

  lines.push(`## Invariants`);
  lines.push("");
  lines.push(`| Epoch | Method | Ops | Share Σ | Sum=1? | Devices | Links | Demands |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const inv of invariants) {
    lines.push(
      `| ${inv.epoch} | \`${inv.method}\` | ${inv.operatorCount} | ${fmtPct(inv.shareSum, 4)} | ${inv.sumOk ? "✅" : "❌"} | ${inv.inputSummary.deviceCount} | ${inv.inputSummary.privateLinkCount} | ${inv.inputSummary.demandCount} |`,
    );
  }
  lines.push("");

  lines.push(`## Per-operator shares across epochs`);
  lines.push("");
  lines.push(
    `| Operator | ${responses.map((r) => r.epoch).join(" | ")} | EH all-time |`,
  );
  lines.push(
    `|---${responses.map(() => "|---").join("")}|---|`,
  );
  for (const t of sorted) {
    const cells = responses.map((r) => {
      const s = t.perEpoch.get(r.epoch);
      return s != null ? fmtPct(s) : "—";
    });
    const eh = t.ehSharePct != null ? `${t.ehSharePct.toFixed(2)}%` : "—";
    lines.push(`| \`${t.code}\` | ${cells.join(" | ")} | ${eh} |`);
  }
  lines.push("");

  lines.push(`## Cross-epoch stability`);
  lines.push("");
  if (stability.length === 0) {
    lines.push(
      `All operators stable (no swings > 0.5pp between adjacent epochs). ✅`,
    );
  } else {
    lines.push(
      `Operators with > 0.5pp share swing between adjacent epochs:`,
    );
    lines.push("");
    lines.push(`| Operator | Max swing | From → To |`);
    lines.push(`|---|---|---|`);
    for (const s of stability.slice(0, 12)) {
      lines.push(
        `| \`${s.code}\` | ${s.maxSwing.toFixed(2)}pp | ${s.swingFrom} → ${s.swingTo} |`,
      );
    }
  }
  lines.push("");

  lines.push(`## Drift vs economic-hub (latest epoch ${latestEp})`);
  lines.push("");
  if (drift.length === 0) {
    lines.push(
      `No operators with both a Shapley share and an economic-hub all-time share.`,
    );
  } else {
    lines.push(
      `Drift = (our solver's latest-epoch share) − (economic-hub all-time payout share).`,
    );
    lines.push(
      `Both are point estimates of different things — drift is informational, not error.`,
    );
    lines.push("");
    lines.push(`| Operator | Solver (latest) | EH all-time | Drift |`);
    lines.push(`|---|---|---|---|`);
    for (const d of drift) {
      lines.push(
        `| \`${d.code}\` | ${d.latestSharePct.toFixed(2)}% | ${d.ehSharePct.toFixed(2)}% | ${fmtPp(d.deltaPp)} |`,
      );
    }
  }
  lines.push("");

  lines.push(`## What this report does NOT prove`);
  lines.push("");
  lines.push(
    `- **Bit-comparable Foundation output.** Until DZ ships the canonical per-epoch CSV inputs (Q1), we can't verify our Shapley values match Foundation runs at the per-epoch level.`,
  );
  lines.push(
    `- **Demand correctness.** We approximate demand from validator counts × stake. The Foundation's demand table is opaque (Q2).`,
  );
  lines.push(
    `- **Public-link latency table.** We use a placeholder pairwise mesh until Q3 lands.`,
  );
  lines.push("");
  lines.push(
    `For canonical Rust solver output, ensure \`SHAPLEY_SERVICE_URL\` is set in Vercel and points to a healthy \`/shapley\` endpoint.`,
  );
  lines.push("");

  const path = join(process.cwd(), "validation-report.md");
  writeFileSync(path, lines.join("\n"));
  console.log("");
  console.log(`Wrote ${path}`);

  // Exit non-zero if any invariant failed — useful in CI
  const anyFailed = invariants.some((i) => !i.sumOk);
  if (anyFailed) {
    console.error("⚠️  Invariants failed. Check report.");
    process.exit(2);
  }
  console.log("✅ All invariants passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
