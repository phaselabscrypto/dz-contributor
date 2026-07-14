#!/usr/bin/env node
/**
 * Generate the epoch-149 DZ-parity fixture for the Rust guardrail test
 * (`services/shapley-rs/tests/parity_epoch149.rs`).
 *
 * Writes two files under `services/shapley-rs/tests/fixtures/epoch149/`:
 *   - `input.json`           — the canonical `ShapleyInputIn` for epoch 149,
 *                              with `city_weights`, and `devices[].operator`
 *                              remapped from contributor CODE → owner PUBKEY so
 *                              the service's output is keyed exactly like DZ's
 *                              on-chain leaves.
 *   - `expected_leaves.json` — DZ's ACTUAL on-chain reward leaves for epoch 149,
 *                              `{ "<owner_pubkey>": <unit_share u32>, ... }`,
 *                              decoded from the contributor-rewards record.
 *
 * The Rust test runs the per-source-city + stake-weighted reward path on
 * `input.json`, converts proportions to `unit_share`s exactly like DZ's
 * `proof.rs`, and asserts the result equals `expected_leaves.json`.
 *
 * Usage (from the dz-contributor repo root):
 *   # snapshot: pass a local file or let it fetch epoch 149 from S3.
 *   # RPC: DZ_LEDGER_RPC_URL must point at a DZ ledger RPC (carries an API key).
 *   DZ_LEDGER_RPC_URL=https://… \
 *     SNAPSHOT=/tmp/mn-epoch-149-snapshot.json \
 *     NODE_OPTIONS=--max-old-space-size=8192 \
 *     npx tsx scripts/gen-epoch149-parity-fixture.ts
 *
 * The 107 MB snapshot parse needs the heap headroom above.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Connection } from "@solana/web3.js";

import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import type { RawSnapshot } from "@/lib/types/snapshot";
import { getSnapshotUrl } from "@/lib/constants/config";
import {
  DZ_RECORD_PROGRAM_ID,
  decodeShapleyOutputStorage,
  deriveContributorRewardsAddress,
  requireDzLedgerRpc,
} from "@/lib/onchain/dz-rewards-record";

const EPOCH = 149;
const OUT_DIR = resolve(
  __dirname,
  "../services/shapley-rs/tests/fixtures/epoch149",
);

async function loadSnapshot(): Promise<RawSnapshot> {
  const local = process.env.SNAPSHOT;
  if (local && existsSync(local)) {
    console.log(`reading local snapshot ${local}`);
    return JSON.parse(readFileSync(local, "utf8")) as RawSnapshot;
  }
  const url = getSnapshotUrl(EPOCH);
  console.log(`fetching epoch ${EPOCH} snapshot: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`snapshot fetch ${res.status} for epoch ${EPOCH}`);
  return (await res.json()) as RawSnapshot;
}

/** Map contributor short code → owner pubkey (the DZ operator identity). */
function buildCodeToOwner(raw: RawSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of Object.values(raw.fetch_data.dz_serviceability.contributors)) {
    if (c.code && c.owner) out.set(c.code, c.owner);
  }
  return out;
}

async function fetchOnchainLeaves(): Promise<Record<string, number>> {
  const rpcUrl = requireDzLedgerRpc();
  const connection = new Connection(rpcUrl, "confirmed");
  const addr = deriveContributorRewardsAddress(EPOCH);
  console.log(`RPC: ${new URL(rpcUrl).host}`);
  console.log(`epoch-${EPOCH} record account: ${addr.toBase58()}`);

  const info = await connection.getAccountInfo(addr);
  if (!info) throw new Error(`epoch-${EPOCH} rewards record not found at ${addr.toBase58()}`);
  if (!info.owner.equals(DZ_RECORD_PROGRAM_ID)) {
    throw new Error(
      `unexpected record owner ${info.owner.toBase58()} (want ${DZ_RECORD_PROGRAM_ID.toBase58()})`,
    );
  }

  const storage = decodeShapleyOutputStorage(info.data);
  if (storage.epoch !== EPOCH) {
    throw new Error(`record epoch ${storage.epoch} != ${EPOCH} — wrong account?`);
  }
  const leaves: Record<string, number> = {};
  for (const r of storage.rewards) leaves[r.contributorKey] = r.unitShare;
  const sum = storage.rewards.reduce((s, r) => s + r.unitShare, 0);
  console.log(
    `decoded ${storage.rewards.length} on-chain leaves, sum=${sum} (stored total=${storage.totalUnitShares})`,
  );
  return leaves;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // 1) Canonical input (code-keyed operators + city_weights).
  //    Epoch 149 predates DZ PR #369, so reproduce it with the HISTORICAL params
  //    (IBRL priority 0.0, public-latency multiplier 1.0) — the builder's default
  //    now targets DZ-current (20.0 / 1.25). This keeps the committed epoch-149
  //    golden faithful; drop the override to regenerate a post-#369 epoch.
  const raw = await loadSnapshot();
  const result = buildCanonicalShapleyInput(raw, {
    ibrlPriority: 0.0,
    publicLatencyMultiplier: 1.0,
  });
  if (!result.canonical) {
    throw new Error(`canonical builder declined epoch ${EPOCH}: ${result.reason}`);
  }
  const input = result.input;
  if (!input.devices.length) throw new Error("canonical builder produced no devices");
  if (!input.city_weights || Object.keys(input.city_weights).length === 0) {
    throw new Error("canonical builder produced no city_weights — cannot run the reward path");
  }

  // 2) Remap operators: contributor CODE → owner PUBKEY (DZ's operator identity)
  //    so the service's output keys match DZ's on-chain contributor_key.
  const codeToOwner = buildCodeToOwner(raw);
  const missing = new Set<string>();
  const remapped = {
    ...input,
    devices: input.devices.map((d) => {
      const owner = codeToOwner.get(d.operator);
      if (!owner) {
        missing.add(d.operator);
        return d;
      }
      return { ...d, operator: owner };
    }),
  };
  if (missing.size > 0) {
    // No silent fixture corruption (#19): every operator must map to a pubkey,
    // or the leaf comparison would be apples-to-oranges.
    throw new Error(
      `contributors missing an owner pubkey, cannot build a pubkey-keyed fixture: ${[...missing].join(", ")}`,
    );
  }

  writeFileSync(`${OUT_DIR}/input.json`, JSON.stringify(remapped, null, 2) + "\n");
  const ops = new Set(remapped.devices.map((d) => d.operator)).size;
  console.log(
    `wrote input.json: operators=${ops} devices=${remapped.devices.length} ` +
      `demands=${remapped.demands.length} cities=${Object.keys(remapped.city_weights ?? {}).length}`,
  );

  // 3) On-chain golden leaves. Requires DZ_LEDGER_RPC_URL (a keyed RPC). When
  //    it's unset we still write input.json — generate the leaves later by
  //    re-running with DZ_LEDGER_RPC_URL set. The Rust parity test skips until
  //    BOTH files exist.
  if (!process.env.DZ_LEDGER_RPC_URL) {
    console.warn(
      "\n⚠️  DZ_LEDGER_RPC_URL not set — wrote input.json only. " +
        "Re-run with DZ_LEDGER_RPC_URL=… to also decode the on-chain leaves " +
        "(expected_leaves.json), which the parity test compares against.",
    );
    return;
  }
  const leaves = await fetchOnchainLeaves();
  writeFileSync(`${OUT_DIR}/expected_leaves.json`, JSON.stringify(leaves, null, 2) + "\n");
  console.log(`wrote expected_leaves.json: ${Object.keys(leaves).length} leaves`);

  // Cross-check operator-set overlap so a mismatch is obvious before the LP runs.
  const ourOps = new Set(remapped.devices.map((d) => d.operator));
  const chainOps = new Set(Object.keys(leaves));
  const onlyOurs = [...ourOps].filter((o) => !chainOps.has(o));
  const onlyChain = [...chainOps].filter((o) => !ourOps.has(o));
  if (onlyOurs.length || onlyChain.length) {
    console.warn(
      `⚠️  operator-set mismatch — only-ours=[${onlyOurs.join(", ")}] ` +
        `only-chain=[${onlyChain.join(", ")}]. The parity test will surface this.`,
    );
  } else {
    console.log("✓ operator sets match between our input and on-chain leaves");
  }
  console.log(
    `\nNext: cd services/shapley-rs && cargo test --test parity_epoch149 -- --ignored --nocapture`,
  );
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
