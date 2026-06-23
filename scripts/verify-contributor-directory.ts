/**
 * Validate the on-chain contributor directory by:
 *   1. Fetching all Contributor accounts from the DZ serviceability program
 *   2. Confirming a known set of (owner → code) pairs from the epoch 117
 *      gist output
 */

import { fetchContributorDirectory } from "../lib/onchain/contributor-directory";

const KNOWN_OWNER_TO_CODE: Record<string, string> = {
  "6gMYmHRyGe4io65DhgTFLHe9sB4w4Ae4uL1yjupcHnHG": "infiber",
  H647kAwTcWsGXZUK3BTr1JyTBZmbNcYyCmRFFCEnXUVp: "jump_",
  "5YbNrJHJJoiRwVEvgAWRGdFRG9gRdZ47hLCKSym8bqbp": "glxy",
  "895D8oq5ceWQ7uzL6VDBu4YfAywuaThQp8qfcP7TWJjK": "dgt",
  "23oq2VMcTUoZ45vbdfGU6wRpfdsNdGhj1jLRGKxzq27K": "rox",
  FUYRNmVyxaP6jsm6KmRgkGYfRNoFC8yCaxytyhwy7Hwb: "tsw",
  E2YfGW9fL8S4vCSpFneusNxQV6Scp8iZPBb7vR3UkoPd: "cherry",
  "5FMtd5Woq5XAAg54jScP5JMoGXqHbombADUfsvcDkcjc": "stakefac",
  "4GCBC7GxLJzoQFdVha84RnNHo3NA3B9FEDnCDyNbhY3F": "cdrw",
  S3Vnv4TYv57igDrjXf96rM1meD7Me4b3FwPKPEs78DZ: "s3v",
  "3Bw6v7EruQvTwoY79h2QjQCs2KBQFzSneBdYUbcXK1Tr": "laconic",
  "3VcVzGYtWuYcX1KQAxVKxUuCty9Xiuob4tv5HS7o8Jxe": "velia",
  "8xZCs9NBhRRGTfsmQ4p7u7k331nfu4rDCmKQo6Epi47A": "allnodes",
  BzNWq22by98cuGm1fFRiDr3JYktPeJDmvoPQZSEv6eWM: "latitude",
};

async function main() {
  const dir = await fetchContributorDirectory();
  console.log(`fetched ${dir.contributors.length} contributors\n`);

  console.log("All entries (sorted by code):");
  for (const c of dir.contributors) {
    console.log(
      `  ${c.code.padEnd(14)}  owner=${c.owner.slice(0, 12)}…  status=${c.status}`,
    );
  }
  console.log();

  let ok = 0;
  let fail = 0;
  console.log("Known epoch 117 reward owner → code assertions:");
  for (const [owner, expectedCode] of Object.entries(KNOWN_OWNER_TO_CODE)) {
    const got = dir.ownerToCode[owner];
    if (got === expectedCode) {
      console.log(`  ✅ ${expectedCode.padEnd(10)}  ${owner.slice(0, 12)}…`);
      ok++;
    } else {
      console.log(
        `  ❌ ${expectedCode.padEnd(10)}  ${owner.slice(0, 12)}…  got=${got ?? "(missing)"}`,
      );
      fail++;
    }
  }
  console.log(`\n${ok}/${ok + fail} owners resolved correctly`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
