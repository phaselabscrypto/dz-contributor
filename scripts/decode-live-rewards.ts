#!/usr/bin/env node
/**
 * Fetch a live contributor-rewards record from the DZ ledger and decode
 * it through our TS reader. Sanity-check that the layout matches what
 * we verified independently with Python.
 *
 *   Address: BE57Te8wAfgRZ231gwBkPBGtkecJmwRTjpdiZrQDR2Y6
 *   Expected epoch: 117
 *   Expected: 14 rewards, top contributor 6gMYmH... at ~40.26%
 *
 * Usage:
 *   npx tsx scripts/decode-live-rewards.ts [address]
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  requireDzLedgerRpc,
  DZ_RECORD_PROGRAM_ID,
  decodeRecordHeader,
  decodeShapleyOutputStorage,
  formatUnitSharePercent,
} from "../lib/onchain/dz-rewards-record";

const KNOWN_EPOCH_117 = "BE57Te8wAfgRZ231gwBkPBGtkecJmwRTjpdiZrQDR2Y6";

async function main() {
  const target = process.argv[2] ?? KNOWN_EPOCH_117;
  const rpcUrl = requireDzLedgerRpc();
  const connection = new Connection(rpcUrl, "confirmed");

  // Log only the host so any API key in the path is redacted.
  console.log(`RPC: ${new URL(rpcUrl).host}`);
  console.log(`Account: ${target}\n`);

  const info = await connection.getAccountInfo(new PublicKey(target));
  if (!info) throw new Error(`account ${target} not found on DZ ledger`);

  if (!info.owner.equals(DZ_RECORD_PROGRAM_ID)) {
    throw new Error(
      `unexpected owner: ${info.owner.toBase58()} (expected ${DZ_RECORD_PROGRAM_ID.toBase58()})`,
    );
  }

  const data = info.data;
  console.log(`total bytes: ${data.length}`);

  const header = decodeRecordHeader(data);
  console.log(`version: ${header.version}`);
  console.log(`authority: ${header.authority}\n`);

  const storage = decodeShapleyOutputStorage(data);
  console.log(`epoch: ${storage.epoch}`);
  console.log(`rewards: ${storage.rewards.length}`);
  console.log(`stored total_unit_shares: ${storage.totalUnitShares}`);
  const computedSum = storage.rewards.reduce((s, r) => s + r.unitShare, 0);
  console.log(`computed sum: ${computedSum}\n`);

  // Rewards table, sorted hi → lo
  const sorted = [...storage.rewards].sort(
    (a, b) => b.unitShare - a.unitShare,
  );
  console.log("Rewards:");
  for (const r of sorted) {
    const pct = formatUnitSharePercent(r.unitShare).padStart(8);
    const blocked = r.isBlocked ? " [BLOCKED]" : "";
    console.log(
      `  ${r.contributorKey.padEnd(44)} ${r.unitShare.toString().padStart(11)} ${pct}${blocked}`,
    );
  }

  // Assertions for epoch 117 (only when caller didn't override the address)
  if (target === KNOWN_EPOCH_117) {
    console.log("\n--- assertions ---");
    const checks: Array<[string, unknown, unknown]> = [
      ["epoch", storage.epoch, 117],
      ["reward count", storage.rewards.length, 14],
      ["top contributor", sorted[0].contributorKey, "6gMYmHRyGe4io65DhgTFLHe9sB4w4Ae4uL1yjupcHnHG"],
      ["top unit_share", sorted[0].unitShare, 402602455],
    ];
    let failed = 0;
    for (const [label, actual, expected] of checks) {
      const ok = actual === expected;
      console.log(`  ${ok ? "✅" : "❌"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
      if (!ok) failed++;
    }
    if (failed > 0) {
      console.log(`\n❌ ${failed} assertion(s) failed.`);
      process.exit(1);
    }
    console.log("\n✅ Layout matches the independent Python decode.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
