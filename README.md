# DZ Contributor Rewards

Live DoubleZero network state, real on-chain reward distribution, and a
Shapley-based forecaster for any add/remove/demand-shift scenario.

Live: <https://dz-contributor.vercel.app>

Built by [Phase](https://phase.cc). Powered by data from
[malbeclabs](https://data.malbeclabs.com),
[doublezero.xyz/economic-hub](https://doublezero.xyz/api/economic-hub),
the DoubleZero Foundation's per-epoch snapshots, and the canonical
[network-shapley-rs](https://github.com/doublezerofoundation/network-shapley-rs)
solver.

Full documentation lives in [docs/](docs/README.md): architecture, data
sources, the Shapley pipeline, the Rust service, local development,
operations, and the ADRs.

## What's here

```
dz-contributor/
├── app/                    Next.js 16 App Router
│   ├── api/                31 server routes (live + on-chain + shapley + diff + cron)
│   ├── (pages)/            Network, Contributors, Validators, Links,
│   │                       Simulate, Link Value, Economics, Rewards,
│   │                       Changelog, Status
│   └── layout.tsx          Sidebar shell + keyboard shortcuts + OG metadata
├── components/             UI primitives + page clients
├── lib/
│   ├── hooks/              SWR hooks for live data, baselines, stake lookups
│   ├── onchain/            DZ ledger + Solana RPC readers (rewards live, registry stubbed)
│   ├── types/              Wire types for snapshots, topology, baselines, diffs
│   └── utils/              Canonical input builder, Rust service client, cron ingest
├── scripts/                Test scripts (pnpm test:*), backfill, parity fixtures
├── services/
│   └── shapley-rs/         Rust HTTP wrapper around network-shapley-rs
│       ├── src/            axum + tokio + rayon; Redis Streams queue; S3 cache; diff index
│       └── tests/          fixture + smoke + cargo-test correctness pins
└── docs/                   Architecture, operations, ADRs
```

## Routes

### Pages

| Route | What it shows |
|---|---|
| `/` | Landing: links into every tool |
| `/network` | Live topology: stats, issues, metro demand, leaderboard, world map |
| `/contributors` | Sortable index: devices/links/metros/bandwidth/live share/all-time share |
| `/contributors/[code]` | Operator detail: reconciliation, changelog, history, links |
| `/contributors/[code]/links` | Per-link value-add breakdown |
| `/validators` | Publishing validators: stake-weighted SOL projection; earnings estimate for any vote account |
| `/validators/calculator` | Vote-pubkey reward calculator with multicast/publishing toggles |
| `/links` | Sortable link table with health overlay |
| `/links/[id]` | Single-link detail with value-add tier |
| `/simulate` | Forecast tool: add/remove links, modify demand, see Shapley delta |
| `/link-value` | Canonical per-link value ranking (retag Shapley, precomputed per epoch) |
| `/economics` | Pool projection, Shapley tracking, share-vs-footprint, distribution |
| `/rewards` | Historical 2Z fee distribution per epoch |
| `/changelog` | Cross-epoch topology diff |
| `/status` | Source-feed health table |

### API

All API routes return JSON. Cached server-side; SWR-cached client-side.

| Route | Purpose |
|---|---|
| `GET /api/live/{topology,stats,status,economic-hub}` | Proxies to malbec + dz feeds |
| `GET /api/epochs[?withMeta=1]` | Available DZ snapshot epochs (latest 31) + sizes/timestamps |
| `GET /api/snapshot?epoch=N` | Raw S3 snapshot |
| `GET /api/epoch-rate` | Measured Solana epoch cadence (drives monthly/yearly projections) |
| `GET /api/fees` | Historical 2Z fee CSV (per-epoch from 934; 859–933 estimated) |
| `GET /api/prices` | Jupiter spot for 2Z + SOL USD |
| `GET /api/publishers` | Multicast publishers: Foundation exports + malbec enrichment |
| `GET /api/validators/stake?pubkey=` | Activated stake for any vote account or node identity |
| `GET /api/shapley?epoch=N` | One epoch's published baseline (cache-only, 404 when not published) |
| `GET /api/shapley/baseline` | Latest published epoch baseline (cache-only, 404 when not published) |
| `GET /api/shapley/tracking?n=N` | Solver share trajectory across the published baselines of the last N epochs |
| `POST /api/shapley/simulate` | Synchronous what-if recompute (programmatic; the page uses the job API) |
| `POST /api/shapley/jobs` + `GET/DELETE /api/shapley/jobs/[id]` | Async what-if: submit → poll → done/cancel; results persist in S3 by request hash |
| `POST /api/link-value/jobs` + `GET/DELETE /api/link-value/jobs/[id]` | Canonical per-link Shapley: faithful retag port of `network_linkestimate`; precomputed per epoch, served from S3 |
| `GET /api/link-value/precompute[?epoch=N]` | Cron (every 6 h, `CRON_SECRET`): one snapshot download → link-value sweep + baseline alias + diff shape, plus history repair |
| `GET /api/economics/projection` | Forward pool projection from historical growth |
| `GET /api/diff?from=&to=` | Network-wide topology diff, served from the Rust diff index |
| `GET /api/diff/contributor/[code]?from=&to=` | Per-operator changelog |
| `GET /api/methodology` | Machine-readable formulas + sources (JSON only) |
| `GET /api/health` | Source-feed health aggregator (also a 15-min cron) |
| `POST /api/vitals` | Web Vitals sink (204) |
| `GET /api/onchain/{contributors,rewards,contributor-rewards}` | Live DZ-ledger reads: contributor directory + decoded contributor-rewards records |
| `GET /api/onchain/{topology,validators}` | Registry / payout stubs: 503 with a stable shape until the DZ IDL lands |

## Architecture

### Data sources

- **malbec**: `data.malbeclabs.com/api/{topology,stats,status,publisher-check}` for current network state
- **dz/economic-hub**: `doublezero.xyz/api/economic-hub` for distributed reward percentages
- **DZ Foundation S3**: immutable per-epoch snapshots (~110 MB each); downloaded only by the cron and the simulate/job routes, never by browser-driven reads
- **DZ Foundation public exports**: multicast validator set + leader slots
- **Fees CSV**: `doublezerofoundation/fees` on GitHub
- **Jupiter**: spot prices for 2Z and SOL
- **Solana RPC**: vote-account stake, epoch cadence, and DZ-ledger contributor-rewards records

Detail, cadences, and failure semantics: [docs/data-sources.md](docs/data-sources.md).

### Shapley solver

The canonical path is the **Rust microservice** (`services/shapley-rs/`),
which wraps Phase's fork of the Foundation's `network-shapley-rs` crate
behind an HTTP API, a Redis Streams job queue, and an S3-compatible result
cache. Set `SHAPLEY_SERVICE_URL` (and `SHAPLEY_API_TOKEN`) to reach it.
Every response carries a `method` label:
`lp-per-city-stake-weighted-exact` for the reward solve, `retag-shapley-rs`
for per-link estimates.

**No-silent-fallback policy.** If the Rust service is unreachable the
routes return `502`. The reward-facing
reads (`/api/shapley`, `/api/shapley/baseline`, `/api/shapley/tracking`) are
cache-only: they probe the epoch alias the cron published and never start a
solve. An epoch that has not been published answers
`404 {"status":"not-cached"}` and the widget is hidden
([ADR 0004](docs/adr/0004-cache-only-baseline-reads.md)).

### Cron, caching, and S3

One Vercel cron, `/api/link-value/precompute` (every 6 hours), downloads
the latest epoch's snapshot once and feeds three consumers from it: the
per-operator link-value sweep, the epoch baseline alias, and the diff shape
for the changelog. It also repairs gaps in the last 31 epochs' diff shapes.
Steady-state fires probe three markers in the Rust service and return in
seconds without a download. The Rust service persists everything under one
bucket: solver results by input hash, epoch aliases and sweep markers under
`shapley/v3/publication/v1/`, and diff shapes under `diff/v1/`. The service
never reads the public snapshot bucket
([ADR 0003](docs/adr/0003-cron-side-snapshot-extraction.md)).

### Forecasting (`/simulate`)

The user picks a contributor, modifies links and demand, and the page
submits an async job to `/api/shapley/jobs` and polls it. The response
carries the `before` and `after` share, 2Z projections, and the
per-contributor delta.

Completed forecasts are shareable via URL: the scenario params (added/removed
links, demand overrides) live in the URL as readable query params; the Share
button copies a link with `run=1` that auto-runs on open, returning instantly
if the result is cached in Redis/S3. Results persist in S3 forever, keyed by
the request hash, so a shared forecast reopened days later completes at
submit time.

### On-chain readers

`lib/onchain/` reads the DZ ledger for contributor-rewards records and the
contributor directory (live, bit-verified), and Solana mainnet for
vote-account stake and epoch cadence. The registry topology and validator
payout readers are stubs. Their routes return 503 with a stable shape until
`DZ_REGISTRY_PROGRAM_ID` / `DZ_REWARDS_PROGRAM_ID` and the IDL land. See
[lib/onchain/README.md](lib/onchain/README.md).

## Local dev

### Frontend only

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>. No env required. The public upstreams work.
Without the Rust service the Shapley, link-value, and diff cards render
nothing or a 503 state.

### Full stack (with Rust Shapley solver)

You need two terminals:

```bash
# Terminal 1: Shapley solver (Rust); the flag opens the compute routes for local dev
cd services/shapley-rs
SHAPLEY_ALLOW_UNAUTHENTICATED=1 cargo run
# → listening on http://localhost:8080
```

```bash
# Terminal 2: Next.js frontend
SHAPLEY_SERVICE_URL=http://localhost:8080 pnpm dev
# → listening on http://localhost:3000
```

Without `SHAPLEY_API_TOKEN` or `SHAPLEY_ALLOW_UNAUTHENTICATED=1` the service
serves only `/health` (fail-closed). Async jobs need Redis plus a `worker`
role, and the baseline/link-value/diff paths need an S3-compatible bucket;
`services/shapley-rs/docker-compose.yml` provides Redis and MinIO. See
[docs/development.md](docs/development.md).

### Verify the Shapley service

```bash
curl -fsS http://localhost:8080/health
# → {"status":"ok","service":"dz-shapley-service","version":"<semver>"}
```

### Run tests

```bash
cd services/shapley-rs && cargo test          # Rust
pnpm lint && pnpm exec tsc --noEmit           # frontend
pnpm test:precompute-ingest                   # one of the pnpm test:* scripts
```

### Optional env

Copy `.env.example` to `.env.local` and uncomment what you need:

```
SHAPLEY_SERVICE_URL=http://localhost:8080   # Rust solver
SHAPLEY_API_TOKEN=<token>                   # compute bearer token, when the service requires it
SHAPLEY_INGEST_TOKEN=<token>                # second token for cron writes (sweep, baseline, diff shape)
CRON_SECRET=<secret>                        # required for /api/link-value/precompute
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
DZ_LEDGER_RPC_URL=<rpc>                     # DZ ledger, for /api/onchain/* reads
DZ_REGISTRY_PROGRAM_ID=<pubkey>             # unset until the Foundation publishes the IDL
DZ_REWARDS_PROGRAM_ID=<pubkey>              # unset until the Foundation publishes the IDL
ONCHAIN_ENABLED=1                           # toggle the stubbed on-chain routes
NEXT_PUBLIC_SITE_URL=https://dz-contributor.vercel.app
```

## Deploy

### Frontend (Vercel)

`main` auto-deploys via Vercel's GitHub integration. Set
`SHAPLEY_SERVICE_URL`, `SHAPLEY_API_TOKEN`, `SHAPLEY_INGEST_TOKEN`, and
`CRON_SECRET` in the project's environment; `vercel.json` registers the two
crons.

### Rust solver

The service is a single container: build it with the provided
`services/shapley-rs/Dockerfile` and run it on any host or orchestrator, as
one or more `api` replicas plus one or more `worker` replicas. It needs:

- `SHAPLEY_API_TOKEN` to require `Authorization: Bearer` on compute
  endpoints (fail-closed: without it, or the dev opt-in, only `/health` is served)
- `SHAPLEY_INGEST_TOKEN`, the second token the cron sends as
  `X-Ingest-Token` on sweep, baseline-publish, and diff-shape writes
- `REDIS_URL` for the job queue (required for the worker and for every
  cron-published baseline; without it `/jobs/*` and `/precompute*` answer 503)
- S3-compatible object storage (`S3_CACHE_BUCKET`, `S3_CACHE_ENDPOINT`,
  standard AWS env credentials) for solver results, epoch aliases, and the
  diff index; without it every baseline read is `404 not-cached` and diff
  writes are 503

```bash
cd services/shapley-rs
docker build -t dz-shapley-service .
docker run -p 8080:8080 --env-file .env dz-shapley-service api
docker run --env-file .env dz-shapley-service worker
```

After deploy, point `SHAPLEY_SERVICE_URL` in the frontend's env at the
service URL, set the matching tokens, then warm the latest epoch with one
authenticated call to `/api/link-value/precompute`. Runbooks are in
[docs/operations.md](docs/operations.md).

## Tests + CI

GitHub Actions in `.github/workflows/`:

- `web.yml`: `pnpm lint`, `tsc --noEmit`, the precompute/diff/baseline
  regression scripts (`pnpm test:*`), and `next build` on Node 20
- `shapley-rs.yml`: `cargo fmt` (advisory), `cargo clippy -D warnings`,
  `cargo test --release` against a Redis service container, then a Docker
  build smoke test, on every change under `services/shapley-rs/**`

Solver correctness is pinned against the Foundation's reference:
`tests/upstream_simple.rs` matches the upstream `simple` example within 1%,
`tests/parity_epoch149.rs` (ignored by default) checks full-epoch reward-leaf
parity, `tests/link_estimate_http.rs` checks the per-link HTTP contract, and
`tests/dedup_devices.rs` covers canonical device handling. The alias,
single-flight, and diff tests (`alias_publication`, `baseline_alias_http`,
`link_estimate_alias`, `shapley_single_flight`, `diff_parity`,
`diff_persistence`) pin the publication and diff-index contracts. The engine
itself (the `network-shapley-rs` fork) is parity-tested against the
Foundation's Python reference. The smoke harness at `tests/smoke.sh`
re-validates a deployed service end-to-end.

## Waiting on DoubleZero

The registry program ID and IDL turn `/api/onchain/topology` and
`/api/onchain/validators` from stubs into live reads.

## License

Apache-2.0 (matching `network-shapley-rs`).
