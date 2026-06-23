# Data Sources

This document describes every upstream feed the DZ Contributor Rewards app reads, including base URLs or env vars, refresh cadence, consuming API routes, and failure semantics. For Shapley input construction see [shapley-pipeline.md](shapley-pipeline.md); for on-chain account decoding internals see [architecture.md](architecture.md).

---

## 1. Malbec live feeds

Malbec Labs publishes real-time DoubleZero network telemetry over a public HTTP API. Three endpoints are consumed: network topology, aggregate statistics, and link-health status.

| Fact | Value |
|---|---|
| Base URL | `https://data.malbeclabs.com/api` |
| Endpoints | `/topology`, `/stats`, `/status` |
| Server cache TTL | 60 s in-process (`TTL_MS = 60_000`) |
| Next.js revalidate | `export const revalidate = 60` |
| Timeout | 10 s (`/stats`, `/status`); 15 s (`/topology` via `live-topology-fetch.ts`) |
| Consuming routes | `app/api/live/topology/route.ts`, `app/api/live/stats/route.ts`, `app/api/live/status/route.ts` |
| Shared fetcher | `lib/utils/live-topology-fetch.ts` (used by topology route and several server-side callers that avoid the self-call pattern) |
| Failure | `/stats` and `/status` forward the upstream HTTP status verbatim and 502 on network/timeout; `/topology` returns 502 on **any** upstream failure (its shared fetcher throws rather than forwarding status) |

A fourth Malbec endpoint, `/dz/publisher-check`, provides publisher enrichment fields that the Foundation feeds do not carry (see [Foundation public exports](#4-foundation-public-exports) for the priority model). It is consumed inside `app/api/publishers/route.ts` with a 5-minute in-process cache (`CACHE_TTL = 5 * 60 * 1000`).

---

## 2. DoubleZero economic hub

The DoubleZero Foundation hosts an economic summary feed exposing current epoch debt, token distribution, burn totals, and per-contributor reward percentages.

| Fact | Value |
|---|---|
| URL | `https://doublezero.xyz/api/economic-hub` |
| Shared fetcher | `lib/utils/economic-hub-fetch.ts` |
| Server cache TTL | 5 min in-process (`TTL_MS = 5 * 60_000`) |
| CDN headers | `public, max-age=300, s-maxage=300, stale-while-revalidate=600` |
| Timeout | 15 s |
| Consuming routes | `app/api/live/economic-hub/route.ts`, `app/api/economics/projection/route.ts` |
| Failure | 502 with `{ error: "Economic-hub fetch failed: …" }` |

The fetcher is shared rather than having `projection` self-call `economic-hub` over HTTP, which avoids cold-start contention on Vercel.

---

## 3. Foundation snapshot S3

The DoubleZero Foundation publishes immutable per-epoch JSON snapshots to a public S3 bucket. Each snapshot encodes the full network topology, link attributes, validator stake, and demand scores for that epoch and is the primary input to Shapley value computation and epoch-diff routes.

| Fact | Value |
|---|---|
| URL template | `https://doublezero-contributor-rewards-mn-beta-snapshots.s3.us-east-1.amazonaws.com/mn-epoch-{N}-snapshot.json` |
| Constant | `S3_SNAPSHOT_URL_TEMPLATE` in `lib/constants/config.ts` |
| Epoch floor | `MIN_DZ_EPOCH = 48` (earliest published epoch) |
| Epoch discovery | Exponential probe + binary-search via HEAD requests; see `lib/utils/epoch-discovery.ts` |
| Discovery cache | 5 min (`CACHE_TTL = 5 * 60 * 1000` in `epoch-discovery.ts`) |
| Snapshot size | ~5 MB per epoch (comment in `app/api/snapshot/route.ts`) |
| Server LRU cache | 8 entries, TTL 5 min (`snapshotCache` in `app/api/snapshot/route.ts`) |
| CDN headers | `public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400` |
| Fetch timeout | 30 s |
| Consuming routes | `app/api/snapshot/route.ts`, `app/api/epochs/route.ts`, `app/api/shapley/route.ts`, `app/api/shapley/baseline/route.ts`, `app/api/diff/route.ts`, `app/api/diff/contributor/[code]/route.ts` |
| Failure | 404 propagated when epoch not found; other S3 errors forwarded verbatim |

Snapshots for completed epochs are immutable; the aggressive CDN TTL (1 h fresh, 24 h stale-while-revalidate) reflects this. Epoch discovery avoids a hard-coded ceiling by probing S3 directly; see `lib/utils/epoch-discovery.ts` for the algorithm.

---

## 4. Foundation public exports

The Foundation publishes two canonical feeds to a separate public S3 bucket: a rolling `latest.json` of all multicast validators, and per-epoch leader-slot data.

| Fact | Value |
|---|---|
| Latest validators URL | `https://doublezero-foundation-public.s3.us-east-2.amazonaws.com/exports/mulitcast_validators/latest.json` |
| Leader slots URL | `https://doublezero-foundation-public.s3.us-east-2.amazonaws.com/exports/multicast_validator_leader_slots/{epoch}.json` |
| Cache TTL | 5 min in-process (`CACHE_TTL = 5 * 60 * 1000`) |
| Timeout | 10 s per request |
| Consuming route | `app/api/publishers/route.ts` |
| Failure | 502 only when both Foundation feeds **and** the Malbec fallback are all unreachable |

**Source priority** (per route comment): Foundation `latest.json` is authoritative for multicast set membership and the `published_shreds` flag; `multicast_validator_leader_slots/{epoch}.json` is authoritative for `leader_slots`, `client_id`, and `software_client`. Malbec `publisher-check` is a best-effort enrichment overlay for fields the Foundation feeds do not carry (`publishing_retransmitted`, `validator_name`, `multicast_connected`, `validator_version`, `is_backup`). A single 502 is returned only if both Foundation and Malbec are simultaneously unreachable.

Note: the `mulitcast_validators` segment in the S3 path is the Foundation's published spelling (transposed i/t). The path must not be corrected unless the Foundation renames it.

---

## 5. Historical fees CSV

The Foundation publishes a consolidated fee-and-payments CSV to a public GitHub repository. The file records per-validator DZ fees in lamports across all settled epochs.

| Fact | Value |
|---|---|
| URL | `https://raw.githubusercontent.com/doublezerofoundation/fees/main/fees_and_payments_consolidated.csv` |
| Constant | `FEE_CONSOLIDATED_URL` in `lib/constants/config.ts` |
| Server cache TTL | 10 min in-process (`CACHE_TTL = 10 * 60 * 1000`) |
| CDN headers | `public, max-age=600, s-maxage=600, stale-while-revalidate=1800` |
| Fetch timeout | 15 s |
| Parser | `lib/utils/fee-parser.ts` → `parseConsolidatedCsv`, `computeFeeHistory` |
| Consuming route | `app/api/fees/route.ts` |
| Epoch coverage | Per-epoch columns for epochs ≥ 934; epochs 859–933 are estimated by averaging the `previous_fees` aggregate column over 75 epochs and are tagged `isEstimated: true` |
| Failure | Upstream HTTP status forwarded verbatim; 500 on timeout or parse error |

The CSV is updated manually by the Foundation at most once per Solana epoch (~2 days), making the 10-minute cache conservative.

---

## 6. Jupiter price feed

Token prices for SOL and 2Z are fetched from the Jupiter Price API v3 to denominate reward estimates in USD.

| Fact | Value |
|---|---|
| URL | `https://lite-api.jup.ag/price/v3` |
| Query | `?ids={2Z_MINT},{SOL_MINT}` |
| 2Z mint | `J6pQQ3FAcJQeWPPGppWRb4nM8jU3wLyYbRrLh7feMfvd` |
| SOL mint | `So11111111111111111111111111111111111111112` |
| Server cache TTL | 60 s in-process (`CACHE_TTL = 60 * 1000`) |
| Fetch timeout | 8 s |
| Consuming routes | `app/api/prices/route.ts` (both tokens); `lib/utils/fee-parser.ts` via `lib/utils/jupiter-price.ts` (SOL only) |
| Failure | 502 when Jupiter returns a non-2xx or when either `usdPrice` field is absent; 500 on network/timeout error (the catch path) |

`lib/utils/jupiter-price.ts` notes that 2Z is not currently tradeable on Jupiter and its `fetch2ZPrice()` helper always returns `null`; the standalone utility is used only for SOL/USD conversion in the fee history path. The `/api/prices` route queries the 2Z mint directly and will return 502 if Jupiter does not return a price for it.

---

## 7. Solana RPC and DZ ledger RPC

Direct on-chain reads require two RPC endpoints: a standard Solana RPC for mainnet account queries, and a separate DZ ledger RPC for reading contributor-rewards records stored on the DZ cluster.

| Fact | Value |
|---|---|
| Solana RPC env var | `SOLANA_RPC_URL` |
| Solana RPC default | `https://api.mainnet-beta.solana.com` |
| DZ ledger RPC env var | `DZ_LEDGER_RPC_URL` (required; no default — see note) |
| Feature gate | `ONCHAIN_ENABLED` (true when `DZ_REGISTRY_PROGRAM_ID` is set, or `ONCHAIN_ENABLED=1`) |
| Program ID env vars | `DZ_REGISTRY_PROGRAM_ID`, `DZ_REWARDS_PROGRAM_ID` |
| Record program ID | `dzrecxigtaZQ3gPmt2X5mDkYigaruFR1rHCqztFTvx7` (constant in `lib/onchain/dz-rewards-record.ts`) |
| Relevant files | `lib/onchain/program-ids.ts`, `lib/onchain/dz-rewards-record.ts` |
| Consuming routes | `app/api/onchain/topology/route.ts`, `app/api/onchain/validators/route.ts`, `app/api/onchain/contributors/route.ts`, `app/api/onchain/rewards/route.ts`, `app/api/onchain/contributor-rewards/route.ts` |
| Failure (unconfigured) | `topology` and `validators` pre-flight-check configuration and return 503 with a stable `{ ready: false, reason: "…" }` shape; `contributors`, `rewards`, and `contributor-rewards` attempt the read directly and surface the failure as a 502 |
| Failure (configured, RPC error) | 502 |

`DZ_LEDGER_RPC_URL` has no built-in default because baking an endpoint value into source would expose a paid API key in the deployed JS bundle. Set it in `.env.local` for development; see `.env.example` for the recommended public endpoint. `DZ_REGISTRY_PROGRAM_ID` and `DZ_REWARDS_PROGRAM_ID` are currently placeholders pending the Foundation publishing the on-chain IDL.

---

## 8. Canonical Shapley inputs (optional)

When the Foundation ships frozen per-epoch CSV inputs, the app can consume them directly instead of deriving inputs from the snapshot blob.

| Fact | Value |
|---|---|
| Env var | `DZ_CANONICAL_INPUTS_URL` |
| URL pattern | e.g. `https://…/epoch-{N}/` — `{N}` is replaced with the epoch number |
| Files fetched | `private_links.csv`, `devices.csv`, `public_links.csv`, `demand.csv` |
| Module | `lib/utils/canonical-inputs.ts` |
| Consuming routes | `app/api/shapley/route.ts` (highest-priority input source when set) |
| Failure | Returns `null`; route falls back to snapshot-derived inputs (labelled `inputSource: "canonical-snapshot"` or `"snapshot-heuristic"` in response) |

When `DZ_CANONICAL_INPUTS_URL` is unset, all Shapley routes derive inputs from the Foundation S3 snapshot (source 3). For the full input-construction pipeline see [shapley-pipeline.md](shapley-pipeline.md).

---

## 9. Health probing

`/api/health` probes all configured upstreams in parallel and exposes a summary for the `/status` page and the sidebar network-pulse indicator.

| Fact | Value |
|---|---|
| Route | `app/api/health/route.ts` |
| Probed sources | `malbec/topology`, `malbec/stats`, `malbec/status`, `dz/economic-hub`; conditionally `shapley-service` and `solana-rpc` |
| Probe timeout | 8 s per source |
| CDN headers | `public, max-age=15, s-maxage=15, stale-while-revalidate=60` |
| Response shape | `{ overall, checkedAt, sources: [{ name, host, status, latencyMs, httpStatus?, errorCode? }] }` |
| `host` field | Hostname only — never includes path, query string, or credentials |
| `errorCode` values | `timeout` \| `network` \| `parse` \| `unknown` (raw error text is discarded) |
| Status values | `ok` when latency ≤ 3 s and HTTP 2xx; `degraded` when latency > 3 s or HTTP 4xx; `down` on HTTP 5xx or network failure; `disabled` for sources that are not configured (e.g. `shapley-service` without `SHAPLEY_SERVICE_URL`, `solana-rpc` without `SOLANA_RPC_URL`) |
| UI consumers | `/status` page (`app/status/page.tsx`), sidebar NetworkPulse component |

Response hardening (security fix H17): full URLs, paths, and auth tokens stay inside the probe closure on the server and are never echoed to the client.

---

## Summary

| Source | URL / env var | Cadence | Consuming routes | Failure |
|---|---|---|---|---|
| Malbec topology | `https://data.malbeclabs.com/api/topology` | 60 s | `app/api/live/topology/route.ts` | 502 |
| Malbec stats | `https://data.malbeclabs.com/api/stats` | 60 s | `app/api/live/stats/route.ts` | 502 |
| Malbec status | `https://data.malbeclabs.com/api/status` | 60 s | `app/api/live/status/route.ts` | 502 |
| Malbec publisher-check | `https://data.malbeclabs.com/api/dz/publisher-check` | 5 min | `app/api/publishers/route.ts` (enrichment only) | Silently omitted; Foundation feed used instead |
| DZ economic hub | `https://doublezero.xyz/api/economic-hub` | 5 min | `app/api/live/economic-hub/route.ts`, `app/api/economics/projection/route.ts` | 502 |
| Foundation snapshot S3 | `S3_SNAPSHOT_URL_TEMPLATE` (config.ts) | Immutable per epoch; discovery 5 min | `app/api/snapshot/route.ts`, shapley + diff routes | 404 / upstream status |
| Foundation multicast validators | `doublezero-foundation-public.s3.us-east-2.amazonaws.com/…/mulitcast_validators/latest.json` | 5 min | `app/api/publishers/route.ts` | 502 if both Foundation + Malbec unreachable |
| Foundation leader slots | `doublezero-foundation-public.s3.us-east-2.amazonaws.com/…/multicast_validator_leader_slots/{epoch}.json` | 5 min | `app/api/publishers/route.ts` | Best-effort; omitted fields default to Malbec values |
| Historical fees CSV | `FEE_CONSOLIDATED_URL` (config.ts) | 10 min | `app/api/fees/route.ts` | Upstream status / 500 |
| Jupiter prices | `https://lite-api.jup.ag/price/v3` | 60 s | `app/api/prices/route.ts`, `lib/utils/fee-parser.ts` | 502 |
| Solana RPC | `SOLANA_RPC_URL` | On-demand | `app/api/onchain/*` | 503 unconfigured (`topology`/`validators` only) / 502 |
| DZ ledger RPC | `DZ_LEDGER_RPC_URL` | On-demand | `app/api/onchain/*` | 503 unconfigured (`topology`/`validators` only) / 502 |
| Canonical Shapley inputs | `DZ_CANONICAL_INPUTS_URL` | On-demand | `app/api/shapley/route.ts` | Falls back to snapshot inputs |
