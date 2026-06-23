#!/usr/bin/env node
/**
 * Parity test: run DZ's canonical Python reference builder
 * (`build_shapley_inputs.py`) and our TS port (`canonical-input-builder.ts`)
 * over the SAME snapshot, then diff the four output tables.
 *
 * Usage:
 *   # Default: tests against /tmp/dz-epoch-149.json
 *   npx tsx scripts/test-canonical-parity.ts
 *
 *   # Custom snapshot:
 *   SNAPSHOT=/path/to/mn-epoch-N-snapshot.json npx tsx scripts/test-canonical-parity.ts
 *
 *   # Custom python reference (defaults to ~/Downloads/build_shapley_inputs.py):
 *   PYTHON_REF=/path/to/build_shapley_inputs.py npx tsx scripts/test-canonical-parity.ts
 *
 * Exits non-zero on any mismatch.
 */

import { readFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { buildCanonicalShapleyInput } from "../lib/utils/canonical-input-builder";
import type { RawSnapshot } from "../lib/types/snapshot";

const SNAPSHOT = process.env.SNAPSHOT ?? "/tmp/dz-epoch-149.json";
const PYTHON_REF =
  process.env.PYTHON_REF ?? `${homedir()}/Downloads/build_shapley_inputs.py`;
const PY = process.env.PYTHON ?? "python3";

interface PyRow {
  [k: string]: unknown;
}
interface PyTables {
  devices: PyRow[];
  private_links: PyRow[];
  public_links: PyRow[];
  demands: PyRow[];
}

function loadPythonReference(): PyTables {
  // Run the Python reference via a tiny driver that dumps JSON to stdout.
  const driver = `
import sys, json
sys.path.insert(0, "${resolve(PYTHON_REF, "..")}")
from build_shapley_inputs import build_tables
print(json.dumps(build_tables(${JSON.stringify(SNAPSHOT)})))
`;
  const r = spawnSync(PY, ["-c", driver], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    process.stderr.write(r.stderr ?? "");
    throw new Error(`python reference failed with status ${r.status}`);
  }
  return JSON.parse(r.stdout) as PyTables;
}

function loadSnapshot(): RawSnapshot {
  return JSON.parse(readFileSync(SNAPSHOT, "utf8")) as RawSnapshot;
}

interface CountedFailure {
  total: number;
  shown: number;
}

function approxEq(a: unknown, b: unknown, tol = 1e-9): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return a === b;
}

function rowKey(row: PyRow, keys: string[]): string {
  return keys.map((k) => String(row[k])).join("|");
}

function compareTable(
  name: string,
  py: PyRow[],
  ts: PyRow[],
  primaryKeys: string[],
  fieldTolerances: Record<string, number> = {},
): boolean {
  const lines: string[] = [];
  let ok = true;
  if (py.length !== ts.length) {
    lines.push(`  ⚠️ row count differs: py=${py.length} ts=${ts.length}`);
    ok = false;
  }

  const pyByKey = new Map<string, PyRow>();
  for (const r of py) pyByKey.set(rowKey(r, primaryKeys), r);
  const tsByKey = new Map<string, PyRow>();
  for (const r of ts) tsByKey.set(rowKey(r, primaryKeys), r);

  const missingFromTs: string[] = [];
  for (const k of pyByKey.keys()) {
    if (!tsByKey.has(k)) missingFromTs.push(k);
  }
  const extraInTs: string[] = [];
  for (const k of tsByKey.keys()) {
    if (!pyByKey.has(k)) extraInTs.push(k);
  }

  if (missingFromTs.length) {
    ok = false;
    lines.push(`  ⚠️ ${missingFromTs.length} rows in py missing from ts`);
    for (const k of missingFromTs.slice(0, 3)) lines.push(`     missing: ${k}`);
  }
  if (extraInTs.length) {
    ok = false;
    lines.push(`  ⚠️ ${extraInTs.length} rows in ts not in py`);
    for (const k of extraInTs.slice(0, 3)) lines.push(`     extra:   ${k}`);
  }

  const fieldFails: Record<string, CountedFailure> = {};
  for (const [k, pyRow] of pyByKey) {
    const tsRow = tsByKey.get(k);
    if (!tsRow) continue;
    const allKeys = new Set([...Object.keys(pyRow), ...Object.keys(tsRow)]);
    for (const f of allKeys) {
      const tol = fieldTolerances[f] ?? 1e-9;
      if (!approxEq(pyRow[f], tsRow[f], tol)) {
        const cf = (fieldFails[f] ??= { total: 0, shown: 0 });
        cf.total++;
        if (cf.shown < 3) {
          cf.shown++;
          lines.push(
            `  ⚠️ ${name}.${f} mismatch at ${k}: py=${JSON.stringify(pyRow[f])} ts=${JSON.stringify(tsRow[f])}`,
          );
        }
      }
    }
  }
  for (const [f, cf] of Object.entries(fieldFails)) {
    if (cf.total > cf.shown) {
      ok = false;
      lines.push(`  ⚠️ ${name}.${f}: total ${cf.total} mismatches across rows`);
    } else if (cf.total > 0) {
      ok = false;
    }
  }

  if (ok) {
    console.log(`✅ ${name}: ${py.length} rows match`);
  } else {
    console.log(`❌ ${name}:`);
    for (const l of lines) console.log(l);
  }
  return ok;
}

function main(): void {
  console.log(`Snapshot: ${SNAPSHOT}`);
  console.log(`Python ref: ${PYTHON_REF}`);
  console.log("");
  try {
    execSync(`test -f ${JSON.stringify(SNAPSHOT)}`, { stdio: "ignore" });
  } catch {
    console.error(`Snapshot not found at ${SNAPSHOT}. Set SNAPSHOT=<path>.`);
    process.exit(2);
  }

  console.log("Loading Python reference output (this parses ~107MB snapshot)…");
  const py = loadPythonReference();
  console.log(
    `  devices=${py.devices.length} private_links=${py.private_links.length}` +
      ` public_links=${py.public_links.length} demands=${py.demands.length}`,
  );

  console.log("Running TS canonical builder…");
  const snap = loadSnapshot();
  const result = buildCanonicalShapleyInput(snap);
  if (!result.canonical) {
    console.error(`TS builder returned canonical=false: ${result.reason}`);
    process.exit(2);
  }
  const ts = result.input;
  console.log(
    `  devices=${ts.devices.length} private_links=${ts.private_links.length}` +
      ` public_links=${ts.public_links.length} demands=${ts.demands.length}`,
  );
  console.log("");

  // Convert TS demand `type` field to `kind` for parity diffing.
  const tsDemands = ts.demands.map((d) => ({
    start: d.start,
    end: d.end,
    receivers: d.receivers,
    traffic: d.traffic,
    priority: d.priority,
    kind: d.type,
    multicast: d.multicast,
  }));

  let ok = true;
  ok = compareTable("devices", py.devices, ts.devices as unknown as PyRow[], ["device"]) && ok;
  ok =
    compareTable(
      "private_links",
      py.private_links,
      ts.private_links as unknown as PyRow[],
      ["device1", "device2"],
      // latency p95 + uptime are derived from float samples — allow tiny epsilon.
      { latency: 1e-6, uptime: 1e-9, shared: 0 },
    ) && ok;
  ok =
    compareTable(
      "public_links",
      py.public_links,
      ts.public_links as unknown as PyRow[],
      ["city1", "city2"],
      { latency: 1e-6 },
    ) && ok;
  ok =
    compareTable(
      "demands",
      py.demands,
      tsDemands as unknown as PyRow[],
      ["start", "end", "kind"],
    ) && ok;

  console.log("");
  if (ok) {
    console.log("✅ All four canonical tables match the Python reference.");
    process.exit(0);
  } else {
    console.log("❌ Parity test failed.");
    process.exit(1);
  }
}

main();
