# On-chain reader status

This directory contains DZ ledger and Solana mainnet readers. **Not
all files are live**: the sections below say which paths are verified
against on-chain data and which are stubs waiting on layout work of
our own. Nothing here waits on a program IDL.

## ✅ Live (verified end-to-end)

These modules return real, bit-verified on-chain data. They are wired
into production API routes and the site UI depends on them.

| Module | What it reads | Verification |
|---|---|---|
| `dz-rewards-record.ts` | `RecordData` header + borsh `ShapleyOutputStorage` payload | Decoded against live epoch 117; matches Foundation CLI bit-for-bit. See `scripts/verify-derive-and-decode.ts`. |
| `rewards.ts` | All contributor-rewards records on the DZ ledger (`getProgramAccounts` + memcmp filter on authority) | Discovery + decode verified for 3+ epochs. See `scripts/decode-live-rewards.ts`. |
| `contributor-directory.ts` | All `AccountType::Contributor` accounts from the DZ serviceability program | Byte layout verified by decoding every live account. All 14 contributors resolve, and their owner keys match the reward rows. See `scripts/verify-contributor-directory.ts`. |

These modules use `@solana/web3.js Connection` directly, require
`DZ_LEDGER_RPC_URL` to be set, and show clear errors when it's not.

## Not implemented (stubs)

These modules exist so call sites can be wired against a stable
function signature before the decoders are written. Every call throws
`OnchainNotConfigured` or returns `{ epochs: [], source: "stub" }`.

None of them needs a program IDL. The live modules above read their
accounts by decoding verified byte offsets. The same approach applies
here. What is missing is the layout work.

| Module | What it would read | What it needs |
|---|---|---|
| `decoders.ts` | Metro, Device, and Link accounts | The byte layout of each account type on the serviceability program, verified against live accounts the way `contributor-directory.ts` verified `AccountType::Contributor`. Then point `decoders.ts` at a registry that implements them. |
| `topology.ts` | Full network topology from on-chain accounts | Depends on `decoders.ts`. Its `DZ_REGISTRY_PROGRAM_ID` gate predates the known program id. |
| `validators.ts` | Per-epoch validator payout history (SOL) | The payout record layout on the rewards program. `DZ_REWARDS_PROGRAM_ID` is already known. |
| `client.ts` | Hand-rolled JSON-RPC client used only by `topology.ts` | Nothing. It works. `@solana/web3.js` would replace it if `topology.ts` is rewritten. |

`idl-registry.ts` and `borsh-registry.ts` were written on an earlier
assumption that an Anchor IDL was required. `borsh-registry.ts` is the
closer starting point: it decodes with raw borsh and reads its schemas
from `idl/schemas.ts`, where they are still placeholders
(`haveSchemas = false`).

The `ACCOUNT_DISCRIMINATORS` table in `program-ids.ts` holds guesses
from before the layout work. It lists Contributor as `0x04`. The
verified value is `10`. Treat every entry in that table as unchecked.

API routes that consume these modules (`/api/onchain/topology`,
`/api/onchain/validators`) sit behind `ONCHAIN_ENABLED` and return 503
with a stable shape when the flag is off. The frontend treats them as
soft-disabled.

## What the live modules already prove

`contributor-directory.ts` reads `AccountType::Contributor` from the
DoubleZero serviceability program at
`ser2VaTMAcYTaauMrTSfSrxBaUDq7BLNs2xfUugTAGv`. Its header documents the
layout: account type at byte 0, owner pubkey at bytes 1 to 33, index at
33 to 49, bump seed at 49, status at 50, code length at 51 to 55, then
the code as UTF-8. Those offsets were verified by decoding every live
contributor account. `dz-rewards-record.ts` decodes reward records the
same way and matches the Foundation CLI byte for byte.

Metro, Device, and Link are account types on that same program. Reading
them is the work above, repeated for three more layouts.

## Why stubs rather than no code at all

1. **Call-site stability.** Consumers that want on-chain reads can wire
   against the function signatures today.
2. **Discoverability.** Grep for `OnchainNotConfigured` to see what is
   unimplemented against what is live. A stub is loud. Missing
   scaffolding is silent.
