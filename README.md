# DZ Contributor Rewards

Live DoubleZero network state, real on-chain reward distribution, and a
Shapley-based forecaster for any add/remove/demand-shift scenario.

Live: <https://dz.phase.cc>

Start here to evaluate or take over this project: [HANDOFF.md](./HANDOFF.md).

Built by [Phase](https://phase.cc). Powered by data from
[malbeclabs](https://data.malbeclabs.com),
[doublezero.xyz/economic-hub](https://doublezero.xyz/api/economic-hub),
and the canonical
[network-shapley-rs](https://github.com/doublezerofoundation/network-shapley-rs)
solver.

## What's here

```
dz-contributor/
├── app/                    Next.js 16 App Router
│   ├── api/                31 server routes (live proxies + on-chain + shapley + link-value + diff + cron)
│   ├── (pages)/            Home, Network, Contributors, Validators, Links,
│   │                       Simulate, Link Value, Economics, Rewards,
│   │                       Changelog, Status
│   └── layout.tsx          Sidebar shell + keyboard shortcuts + OG metadata
├── components/             UI primitives + page clients
├── lib/
│   ├── hooks/              SWR hooks for live data, baselines, stake lookups
│   ├── onchain/            Solana RPC + DZ ledger readers
│   ├── types/              Wire types for snapshots, topology, etc.
│   └── utils/              Shapley input builders + heuristics + CSV
└── services/
    └── shapley-rs/         Rust HTTP wrapper around network-shapley-rs
        ├── src/            axum + tokio + rayon
        └── tests/          fixture + smoke + cargo-test correctness pins
```

## Routes

### Pages

| Route | What it shows |
|---|---|
| `/` | Landing page. Links to Forecast, Link Rewards, and every tool. |
| `/network` | Live topology: stats, issues, metro demand, leaderboard, world map. |
| `/contributors` | Sortable index: devices, links, metros, bandwidth, live share, all-time share. |
| `/contributors/[code]` | Operator detail: reconciliation, changelog, history, links. |
| `/contributors/[code]/links` | Per-link value-add breakdown for one operator. |
| `/validators` | Publishing validators, stake-weighted SOL projection. Paste any Solana vote account for an inline earnings estimate. |
| `/validators/calculator` | Redirects to `/validators`. Keeps old bookmarks and `?vote=` links working. |
| `/links` | Sortable link table with health overlay. |
| `/links/[id]` | Single-link detail with value-add tier. |
| `/simulate` | Forecast tool. Add or remove links, change demand, see the Shapley delta. |
| `/link-value` | **Link Rewards** page. Canonical per-link Shapley (retag method) only, no heuristic. Operators over 19 focus links see an empty state instead of a job. |
| `/economics` | Pool projection, Shapley tracking, share-vs-footprint, distribution. |
| `/rewards` | Historical SOL fee distribution per epoch. |
| `/changelog` | Cross-epoch topology diff. |
| `/status` | Source-feed health table. |

### API

All API routes return JSON. Cached server-side; SWR-cached client-side.

| Route | Purpose |
|---|---|
| `GET /api/live/{topology,stats,status,economic-hub}` | Proxies malbec (`topology`, `stats`, `status`) and the DZ economic hub for current network state. |
| `GET /api/epochs[?withMeta=1]` | Available DZ snapshot epochs, with sizes and timestamps when `withMeta=1`. |
| `GET /api/epoch-rate` | Measured Solana epoch cadence (epochs per month and year), for SOL projections. |
| `GET /api/snapshot?epoch=N` | Raw S3 snapshot for one epoch. |
| `GET /api/fees` | Fee history parsed from the Foundation's CSV. Per-epoch columns are discovered by regex; no fixed epoch ceiling. |
| `GET /api/prices` | Jupiter spot price for 2Z and SOL. |
| `GET /api/publishers` | Live publisher data from malbec. |
| `GET /api/validators/stake?pubkey=` | Activated stake for any Solana vote account. `404` when the pubkey isn't a vote account, `502` on an RPC failure. |
| `GET /api/shapley?epoch=N` | Per-operator Shapley share for a historical snapshot. |
| `POST /api/shapley/simulate` | Synchronous what-if recompute. `/simulate` does not call this; it uses the async job API below. |
| `POST /api/shapley/jobs` + `GET/DELETE /api/shapley/jobs/[id]` | Async what-if simulation for `/simulate`: submit, poll, cancel. |
| `GET /api/shapley/baseline` | Latest epoch's published baseline. Cache-only; `404 not-cached` until the cron publishes it. |
| `GET /api/shapley/tracking?count=N` | Solver share trajectory across the published baselines of the last N epochs. Cache-only. |
| `POST /api/link-value/jobs` + `GET/DELETE /api/link-value/jobs/[id]` | Canonical per-link Shapley: async submit, poll, cancel. Precomputed per epoch, served from S3. |
| `GET /api/link-value/precompute` | The only cron that computes. Every 6 hours it downloads the latest epoch's snapshot once and publishes the link-value sweep, the baseline alias, and the diff shape from it, then repairs historical diff-shape gaps. Requires `CRON_SECRET` and `SHAPLEY_INGEST_TOKEN`. |
| `GET /api/economics/projection` | Forward pool projection from historical growth. |
| `GET /api/diff?from=&to=` | Network-wide topology diff between two epochs, served from the Rust diff index. |
| `GET /api/diff/contributor/[code]?from=&to=` | Per-operator changelog between two epochs. |
| `GET /api/methodology` | Machine-readable formulas and sources. JSON only; there is no Methodology page. |
| `GET /api/health` | Source-feed health aggregator. Vercel cron every 15 minutes. |
| `POST /api/vitals` | Web vitals sink. No-op until a metrics backend is wired. |
| `GET /api/onchain/{topology,validators}` | `503` with a stable `{ ready: false, reason }` shape. |
| `GET /api/onchain/{contributors,rewards,contributor-rewards}` | Live reads from the DZ ledger. `502` on an upstream failure. |

## Architecture

### Data sources (live)

- **malbec**: `data.malbeclabs.com/api/{topology,stats,status}` and `/api/dz/publisher-check` for current network state
- **dz/economic-hub**: `doublezero.xyz/api/economic-hub` for distributed reward percentages
- **DZ Foundation S3**: historical per-epoch snapshots
- **Jupiter**: spot prices for 2Z and SOL
- **Solana RPC**: live reads for vote-account stake (`/api/validators/stake`) and epoch timing (`/api/epoch-rate`) on mainnet, plus reward records and the contributor directory on the DZ ledger.

### Shapley solver

The canonical path is the **Rust microservice** (`services/shapley-rs/`),
which wraps Phase's fork of the Foundation's `network-shapley-rs` crate.
Set `SHAPLEY_SERVICE_URL` and `SHAPLEY_API_TOKEN` to reach it. Every
response carries the `method` it used: `lp-per-city-stake-weighted-exact`
for the reward solve, `retag-shapley-rs` for per-link estimates.

**No silent fallback.** If the Rust service is unreachable the routes
return `502`. There is no in-process solver.

**Reads never compute.** `/api/shapley`, `/api/shapley/baseline`, and
`/api/shapley/tracking` probe the epoch alias the cron published and
answer `404 {"status":"not-cached"}` when there is none, which hides the
widget. Only the cron asks the service to solve.

### Cron, caching, and S3

One cron does the epoch work: `/api/link-value/precompute`, every six
hours. It probes the sweep marker, the baseline alias, and the missing
diff shapes, and a satisfied epoch returns `already-swept` with no
download. Otherwise it downloads the snapshot once and feeds the
link-value sweep, the baseline alias, and the diff shape from it, then
repairs historical shape gaps.

The Rust service keeps everything in one S3-compatible bucket: solver
results by input hash, epoch aliases and sweep markers under
`shapley/v3/publication/v1/`, and diff shapes under `diff/v1/`. It never
reads the public snapshot bucket.

### Forecasting (`/simulate`)

The page uses the async job API. `POST /api/shapley/jobs` starts a run
and returns a job id. The page polls `GET /api/shapley/jobs/[id]` once
a second and cancels with `DELETE`. The synchronous `POST
/api/shapley/simulate` route still exists. The page does not call it.

The running modal shows two named stages, baseline and what-if, plus a
coalition counter and elapsed time. It also shows a rolling time-left
estimate and the typical runtime of recent runs.

The finished result gives before/after Shapley share, a projected SOL
change, and the per-contributor delta. The simulator caches the
per-epoch baseline so later edits only re-solve the modified scenario.

Completed forecasts are shareable via URL. The scenario params
(added/removed links, demand overrides) live in the URL as readable
query params. The Share button copies a link with `run=1` that
auto-runs on open, returning instantly if the result is cached in
Redis/S3. Results persist in S3 forever, keyed by the request hash, so
a shared forecast reopened days later recomputes instantly.

### On-chain readers

Three `lib/onchain/` modules are live: `dz-rewards-record.ts`,
`rewards.ts`, and `contributor-directory.ts` (verified against on-chain
data, see `lib/onchain/README.md`). They read the DZ ledger, a separate
Solana sidechain.

`vote-stake.ts` reads Solana mainnet directly and backs
`/api/validators/stake`, outside the `/api/onchain/*` namespace.

`GET /api/onchain/topology` and `GET /api/onchain/validators` answer
`503` with a stable `{ ready: false, reason }` shape.
`contributor-directory.ts` reads `AccountType::Contributor` from the
DoubleZero serviceability program
(`ser2VaTMAcYTaauMrTSfSrxBaUDq7BLNs2xfUugTAGv`) by verified byte
offsets, and `dz-rewards-record.ts` reads reward records on the record
program the same way. `GET
/api/onchain/{contributors,rewards,contributor-rewards}` read live data
today and return `502` on an upstream failure.

## Local dev

### Frontend only (no Rust solver)

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>. No env is required. It falls back to the
TS coalition-enumeration solver and public upstreams.

### Full stack (with Rust Shapley solver)

You need two terminals:

```bash
# Terminal 1: Shapley solver (Rust)
cd services/shapley-rs
cargo run
# → listening on http://localhost:8080
```

```bash
# Terminal 2: Next.js frontend
SHAPLEY_SERVICE_URL=http://localhost:8080 npm run dev
# → listening on http://localhost:3000
```

The frontend detects `SHAPLEY_SERVICE_URL` and routes Shapley requests
to the Rust service. Responses carry `lp-per-city-stake-weighted-exact`
(reward solve) or `retag-shapley-rs` (per-link). If the Rust service is
unreachable, the request returns `502`. There is no automatic fallback.

### Verify the Shapley service

```bash
curl -fsS http://localhost:8080/health
# → {"status":"ok","service":"dz-shapley-service","version":"0.1.0"}
```

### Run Shapley tests

```bash
cd services/shapley-rs
cargo test
```

### Environment

Copy `.env.example` to `.env.local` for local dev. Production needs
five variables:

- `SHAPLEY_SERVICE_URL`
- `SHAPLEY_API_TOKEN`
- `SHAPLEY_INGEST_TOKEN`
- `CRON_SECRET`
- `DZ_LEDGER_RPC_URL`

See `docs/operations.md` sections 3 and 4 for the full reference,
defaults, and what happens when each variable is unset.

## Deploy

### Frontend (Vercel)

`main` auto-deploys via Vercel's GitHub integration. No manual step.

### Rust solver

The service is a single container. Build it with the provided
`services/shapley-rs/Dockerfile` and run it on any host or
orchestrator. It needs:

- `SHAPLEY_API_TOKEN` to require `Authorization: Bearer` on compute
  endpoints. Without it, and without the dev opt-in, only `/health` is
  served
- `SHAPLEY_INGEST_TOKEN`, the second token the cron sends as
  `X-Ingest-Token` on sweep, baseline-publish, and diff-shape writes
- `REDIS_URL` for the job queue. The worker requires it, and without it
  `/jobs/*` and `/precompute*` answer 503, so no baseline can be
  published
- S3-compatible object storage (`S3_CACHE_BUCKET`, `S3_CACHE_ENDPOINT`,
  standard AWS env credentials) for solver results, epoch aliases, and
  the diff index. Without it every baseline read is `404 not-cached` and
  diff writes are 503

```bash
cd services/shapley-rs
docker build -t dz-shapley-service .
docker run -p 8080:8080 -e SHAPLEY_API_TOKEN=$(openssl rand -hex 32) dz-shapley-service api
# worker role (one or more replicas), required for /jobs/*:
docker run -e REDIS_URL=... dz-shapley-service worker
```

After deploy, point `SHAPLEY_SERVICE_URL` in the frontend's env at the
service URL, set the matching tokens, then warm the latest epoch with one
authenticated call to `/api/link-value/precompute`. Runbooks are in
`docs/operations.md`.


## Tests + CI

GitHub Actions in `.github/workflows/`:

- `web.yml`: `next build` + `eslint` on every push
- `shapley-rs.yml`: `cargo build` + `cargo test` + `cargo clippy` for
  the Rust microservice on every push to `services/shapley-rs/**`

Solver correctness is pinned against the Foundation's reference:
`tests/upstream_simple.rs` matches the upstream `simple` example within
1%, `tests/link_estimate_http.rs` checks the per-link HTTP contract and
over-cap handling, and `tests/dedup_devices.rs` covers canonical device
handling. The engine itself (the `network-shapley-rs` fork) is
parity-tested against the Foundation's Python reference (`network_shapley`
and `network_linkestimate`). The smoke harness at `tests/smoke.sh`
re-validates the deployed service end-to-end.

## License

Apache-2.0 (matching `network-shapley-rs`).
