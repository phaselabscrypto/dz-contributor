# On-chain reader status

This directory contains DZ ledger / Solana mainnet readers. **Not all
files are live** — the pieces below describe which paths are bit-
verified against on-chain data and which are scaffolding awaiting
DZ Foundation work.

## ✅ Live (verified end-to-end)

These modules return real, bit-verified on-chain data. They are wired
into production API routes and the site UI depends on them.

| Module | What it reads | Verification |
|---|---|---|
| `dz-rewards-record.ts` | `RecordData` header + borsh `ShapleyOutputStorage` payload | Decoded against live epoch 117; matches Foundation CLI bit-for-bit. See `scripts/verify-derive-and-decode.ts`. |
| `rewards.ts` | All contributor-rewards records on the DZ ledger (`getProgramAccounts` + memcmp filter on authority) | Discovery + decode verified for 3+ epochs. See `scripts/decode-live-rewards.ts`. |
| `contributor-directory.ts` | All `AccountType::Contributor` accounts from the DZ serviceability program | Cross-checked against the gist's known reward keys. All 14 contributors resolve correctly. |

These modules use `@solana/web3.js Connection` directly, require
`DZ_LEDGER_RPC_URL` to be set, and surface clear errors when it's not.

## ⚠️ Scaffolding (stubbed, pending DZ IDL)

These modules exist so call sites can be wired against a stable
function signature **before** the underlying decoders are available.
Every call currently throws `OnchainNotConfigured` or returns
`{ epochs: [], source: "stub" }`.

| Module | What it would read | What's blocking |
|---|---|---|
| `decoders.ts` | Metro / Device / Link / Contributor records via Anchor IDL | DZ Q6 — needs the IDL JSON dropped at `lib/onchain/idl/dz-registry.json` and `idl-registry.ts` swapped from `stubRegistry` → `anchorRegistry`. |
| `topology.ts` | Full network topology from on-chain registry | Same — depends on `decoders.ts`. |
| `validators.ts` | Per-epoch validator payout history (SOL) | DZ Q6 — needs `DZ_REWARDS_PROGRAM_ID` set + the rewards-program IDL. |
| `client.ts` | Hand-rolled JSON-RPC client used only by `topology.ts` | Kept thin until the IDL lands; will likely be replaced by `@solana/web3.js` at that point. |

API routes that consume these modules (`/api/onchain/topology`,
`/api/onchain/validators`) are gated behind `ONCHAIN_ENABLED` env var
and return **503 with a stable shape** when the flag is off — frontend
treats them as soft-disabled.

## Activation checklist (when DZ ships the IDL)

1. Drop `idl/dz-registry.json` (anchor IDL)
2. In `idl-registry.ts`, swap the export:
   ```ts
   // export const registry: IdlRegistry = stubRegistry;
   export const registry: IdlRegistry = anchorRegistry;
   ```
3. Set Vercel env:
   ```
   vercel env add DZ_REGISTRY_PROGRAM_ID production
   vercel env add DZ_REWARDS_PROGRAM_ID production
   vercel env add SOLANA_RPC_URL production
   vercel env add ONCHAIN_ENABLED production   # set to 1
   ```
4. Trigger a Vercel redeploy
5. Verify `/api/onchain/topology` and `/api/onchain/validators` return
   live data instead of 503

## Why scaffolding rather than no code at all

Two reasons:

1. **Call-site stability.** Every consumer that wants on-chain reads
   (live-topology fallback, validator detail pages, etc.) can wire
   against the function signatures today. Activation is one
   `idl-registry.ts` line swap and an env-var flip.
2. **Discoverability.** A new contributor to this repo can grep for
   `OnchainNotConfigured` and immediately see what's pending vs live.
   Adding a stub is loud; missing scaffolding is silent.
