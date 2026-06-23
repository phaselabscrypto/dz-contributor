/**
 * Contributor directory reader.
 *
 * Walks the DZ serviceability program (`ser2VaTMAcYTaauMrTSfSrxBaUDq7BLNs2xfUugTAGv`)
 * for all `AccountType::Contributor` accounts (discriminant byte = 10) and
 * decodes each into `{ code, owner }`. The `owner` Pubkey here is the same
 * value that appears as `contributor_key` inside every `RewardShare` in the
 * on-chain `ShapleyOutputStorage` record, so this is the bridge between
 * on-chain reward rows and the human-readable contributor codes the rest
 * of the site uses (matches malbec topology + economic-hub naming).
 *
 * Account layout (verified by decoding all 14 live records on the DZ
 * ledger and cross-checking against the gist's known reward keys):
 *
 *   byte  0       : account_type u8           = 10 for Contributor
 *   bytes 1..33   : owner Pubkey              (32)
 *   bytes 33..49  : index u128                (16)
 *   byte 49       : bump_seed u8              (1)
 *   byte 50       : status u8                 (1)   1 = Activated
 *   bytes 51..55  : code length u32 LE        (4)
 *   bytes 55..    : code utf-8                (len)
 *   then          : reference_count u32       (4)
 *                   ops_manager Pubkey        (32)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { requireDzLedgerRpc } from "./dz-rewards-record";

export const DZ_SERVICEABILITY_PROGRAM_ID = new PublicKey(
  "ser2VaTMAcYTaauMrTSfSrxBaUDq7BLNs2xfUugTAGv",
);

const ACCOUNT_TYPE_CONTRIBUTOR = 10;

export interface ContributorEntry {
  /** On-chain account address of the Contributor PDA itself. */
  account: string;
  /** Owner pubkey — same value used as `contributor_key` in reward rows. */
  owner: string;
  /** Short code (e.g. "infiber", "jump_"). Matches malbec topology codes. */
  code: string;
  /** 1 = Activated, 2 = Suspended, 3 = Deleting, 0 = None. */
  status: number;
}

export interface ContributorDirectory {
  contributors: ContributorEntry[];
  /** owner pubkey → code lookup (the common case). */
  ownerToCode: Record<string, string>;
  /** code → owner pubkey lookup. */
  codeToOwner: Record<string, string>;
  fetchedAt: string;
}

function decodeContributor(
  account: string,
  data: Uint8Array,
): ContributorEntry | null {
  if (data.length < 55) return null;
  if (data[0] !== ACCOUNT_TYPE_CONTRIBUTOR) return null;

  const owner = bs58.encode(data.slice(1, 33));
  // skip index (16) and bump_seed (1)
  const status = data[50];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const codeLen = view.getUint32(51, true);
  if (codeLen > 64 || 55 + codeLen > data.length) return null;
  const code = new TextDecoder("utf-8").decode(data.slice(55, 55 + codeLen));
  return { account, owner, code, status };
}

/**
 * Fetch and decode every contributor account from the DZ ledger.
 * Returns the full directory with both lookup directions pre-built.
 *
 * Caller is responsible for caching — this hits `getProgramAccounts` with
 * a memcmp filter on the discriminant byte, which is reasonably fast (~14
 * records, ~100 bytes each) but still an RPC call.
 */
export async function fetchContributorDirectory(
  rpcUrl?: string,
): Promise<ContributorDirectory> {
  const connection = new Connection(rpcUrl ?? requireDzLedgerRpc(), "confirmed");

  const accounts = await connection.getProgramAccounts(
    DZ_SERVICEABILITY_PROGRAM_ID,
    {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: bs58.encode(new Uint8Array([ACCOUNT_TYPE_CONTRIBUTOR])),
          },
        },
      ],
    },
  );

  const contributors: ContributorEntry[] = [];
  for (const { pubkey, account } of accounts) {
    const entry = decodeContributor(pubkey.toBase58(), account.data);
    if (entry) contributors.push(entry);
  }
  contributors.sort((a, b) => a.code.localeCompare(b.code));

  const ownerToCode: Record<string, string> = {};
  const codeToOwner: Record<string, string> = {};
  for (const c of contributors) {
    ownerToCode[c.owner] = c.code;
    codeToOwner[c.code] = c.owner;
  }

  return {
    contributors,
    ownerToCode,
    codeToOwner,
    fetchedAt: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Module-level cache. The contributor set changes rarely (new contributors
// onboard maybe once a week); caching for 10 minutes keeps RPC pressure low
// while still picking up new entries within a reasonable window.
// ────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;
let cached: { data: ContributorDirectory; timestamp: number } | null = null;

export async function getContributorDirectory(): Promise<ContributorDirectory> {
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetchContributorDirectory();
  cached = { data, timestamp: Date.now() };
  return data;
}

/** Convenience: resolve a contributor code to its owner pubkey. */
export async function resolveContributorOwner(
  code: string,
): Promise<string | null> {
  const dir = await getContributorDirectory();
  return dir.codeToOwner[code] ?? null;
}

/** Convenience: resolve an owner pubkey to its contributor code. */
export async function resolveContributorCode(
  owner: string,
): Promise<string | null> {
  const dir = await getContributorDirectory();
  return dir.ownerToCode[owner] ?? null;
}
