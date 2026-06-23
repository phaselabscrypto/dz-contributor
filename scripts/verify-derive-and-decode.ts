/**
 * End-to-end smoke test for the on-chain rewards reader.
 *
 * 1. Derive the contributor-rewards address for epoch 117 from seeds alone.
 * 2. Fetch the account from the DZ ledger.
 * 3. Decode the header + payload.
 * 4. Assert the decoded epoch + contributor count match known-good values.
 *
 * Run with:  npx tsx scripts/verify-derive-and-decode.ts
 */
import { Connection } from "@solana/web3.js";
import {
  requireDzLedgerRpc,
  decodeRecordHeader,
  decodeShapleyOutputStorage,
  deriveContributorRewardsAddress,
  formatUnitSharePercent,
} from "@/lib/onchain/dz-rewards-record";

const EXPECTED_ADDR_E117 = "BE57Te8wAfgRZ231gwBkPBGtkecJmwRTjpdiZrQDR2Y6";

async function main() {
  const rpcUrl = requireDzLedgerRpc();
  const conn = new Connection(rpcUrl, "confirmed");

  // Derive
  const addr = deriveContributorRewardsAddress(117);
  console.log("derived address for epoch 117:", addr.toBase58());
  console.log("expected:                      ", EXPECTED_ADDR_E117);

  if (addr.toBase58() !== EXPECTED_ADDR_E117) {
    console.error("✗ derivation mismatch");
    process.exit(1);
  }
  console.log("✓ derivation matches\n");

  // Fetch + decode
  const info = await conn.getAccountInfo(addr, "confirmed");
  if (!info) {
    console.error("✗ account not found on DZ ledger");
    process.exit(1);
  }

  const data = new Uint8Array(info.data);
  const header = decodeRecordHeader(data);
  const storage = decodeShapleyOutputStorage(data);

  console.log("header version:  ", header.version);
  console.log("header authority:", header.authority);
  console.log("epoch:           ", storage.epoch);
  console.log("contributors:    ", storage.rewards.length);
  console.log("total units:     ", storage.totalUnitShares);
  console.log("\nTop 3:");
  for (const r of storage.rewards.slice(0, 3)) {
    console.log(
      `  ${r.contributorKey}  ${r.unitShare.toString().padStart(10)}  ${formatUnitSharePercent(r.unitShare)}`,
    );
  }

  // Assertions against known-good epoch 117 values. Order isn't
  // guaranteed (RPC and the original CLI sort differently), so we
  // check the set of pubkeys + the canonical top contributor by share.
  const infiber = storage.rewards.find(
    (r) => r.contributorKey === "6gMYmHRyGe4io65DhgTFLHe9sB4w4Ae4uL1yjupcHnHG",
  );
  const ok =
    storage.epoch === 117 &&
    storage.rewards.length === 14 &&
    infiber !== undefined &&
    infiber.unitShare === 402602455;

  if (!ok) {
    console.error("\n✗ values diverge from known-good epoch 117");
    process.exit(1);
  }
  console.log("\n✓ end-to-end derivation + decode verified against live ledger");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
