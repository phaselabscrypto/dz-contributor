# DZ Contributor Rewards

Live DoubleZero network state, real on-chain reward distribution, and a
Shapley-based forecaster for any add/remove/demand-shift scenario.

Live: <https://dz-contributor.vercel.app>

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
│   ├── api/                17 server routes (live + on-chain + shapley + diff)
│   ├── (pages)/            Network, Contributors, Validators, Links,
│   │                       Simulate, Link Value, Economics, Rewards,
│   │                       Changelog, Status, Methodology
│   └── layout.tsx          Sidebar shell + keyboard shortcuts + OG metadata
├── components/             UI primitives + page clients
├── lib/
│   ├── hooks/              SWR hooks for live data + baseline shapley
│   ├── onchain/            Solana RPC reader stubs (pending DZ IDL)
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
| `/` | Landing — links into every tool |
| `/network` | Live topology: stats, issues, metro demand, leaderboard, world map |
| `/contributors` | Sortable index — devices/links/metros/bandwidth/live share/all-time share |
| `/contributors/[code]` | Operator detail — reconciliation, changelog, history, links |
| `/contributors/[code]/links` | Per-link value-add breakdown |
| `/validators` | Publishing validators — stake-weighted SOL projection |
| `/validators/calculator` | Vote-pubkey reward calculator with multicast/publishing toggles |
| `/links` | Sortable link table with health overlay |
| `/links/[id]` | Single-link detail with value-add tier |
| `/simulate` | Forecast tool — add/remove links, modify demand, see Shapley delta |
| `/link-value` | Heuristic per-link ranking (canonical when Rust service is wired) |
| `/economics` | Pool projection, Shapley tracking, share-vs-footprint, distribution |
| `/rewards` | Historical 2Z fee distribution per epoch |
| `/changelog` | Cross-epoch topology diff |
| `/status` | Source-feed health table |
| `/methodology` | Every formula and source documented inline |

### API

All API routes return JSON. Cached server-side; SWR-cached client-side.

| Route | Purpose |
|---|---|
| `GET /api/live/{topology,stats,status,economic-hub}` | Proxies to malbec + dz feeds |
| `GET /api/epochs[?withMeta=1]` | Available DZ snapshot epochs + sizes/timestamps |
| `GET /api/snapshot?epoch=N` | Raw S3 snapshot |
| `GET /api/fees` | Historical 2Z fee CSV (epochs 859–938) |
| `GET /api/prices` | Jupiter spot for 2Z + SOL USD |
| `GET /api/publishers` | Live publisher data from malbec |
| `GET /api/shapley?epoch=N` | Per-operator Shapley share for a historical snapshot |
| `POST /api/shapley/simulate` | Recompute Shapley after add/remove/demand edits |
| `GET /api/shapley/baseline` | Live-network Shapley anchor (5-min cache) |
| `GET /api/shapley/tracking?n=N` | Solver share trajectory across last N snapshots |
| `POST /api/link-value/jobs` + `GET/DELETE /api/link-value/jobs/[id]` | Canonical per-link Shapley — faithful retag port of `network_linkestimate`; async submit → poll → done/cancel (precomputed per epoch, served from S3) |
| `GET /api/economics/projection` | Forward pool projection from historical growth |
| `GET /api/diff?from=&to=` | Network-wide topology diff |
| `GET /api/diff/contributor/[code]?from=&to=` | Per-operator changelog |
| `GET /api/methodology` | Machine-readable formulas + sources |
| `GET /api/health` | Source-feed health aggregator |
| `GET /api/onchain/{topology,rewards,validators,contributor-rewards}` | RPC reader stubs (503 until DZ IDL lands) |

## Architecture

### Data sources (live)

- **malbec** — `data.malbeclabs.com/api/{topology,stats,status,publisher-check}` for current network state
- **dz/economic-hub** — `doublezero.xyz/api/economic-hub` for distributed reward percentages
- **DZ Foundation S3** — historical per-epoch snapshots
- **Jupiter** — spot prices for 2Z and SOL
- **Solana RPC** — direct on-chain reads (stubs ready, awaiting DZ program IDs)

### Shapley solver

The canonical path is the **Rust microservice** (`services/shapley-rs/`),
which wraps Phase's fork of the Foundation's `network-shapley-rs` crate.
Set `SHAPLEY_SERVICE_URL` to its URL after deploy. Every response is
labelled with the `method` used — `lp-multi-commodity-flow-rs` for the
reward solve, `retag-shapley-rs` for per-link estimates.

There is **no silent fallback**: if the Rust service is unreachable the
routes return `502` rather than substituting a heuristic. A TypeScript
coalition-enumeration solver (`lib/utils/shapley-solver.ts`) remains in
the tree for local dev/reference only — it does not serve production
responses.

### Forecasting (`/simulate`)

User picks a contributor → modifies links + demand → POST to
`/api/shapley/simulate` → response includes `before`/`after` share + 2Z
projections + per-contributor delta. The simulator caches the per-epoch
baseline so subsequent edits only re-solve the modified scenario.

Completed forecasts are shareable via URL — the scenario params (added/removed
links, demand overrides) live in the URL as readable query params; the Share
button copies a link with `run=1` that auto-runs on open, returning instantly
if the result is cached in Redis/S3. Results persist in S3 forever, keyed by
the request hash, so a shared forecast reopened days later recomputes
instantly.

### On-chain readers (stubs)

`lib/onchain/` has typed RPC client + decoder stubs ready for the DZ
program IDs. Routes return 503 with a stable shape until
`DZ_REGISTRY_PROGRAM_ID` and `DZ_REWARDS_PROGRAM_ID` env vars are set
and the IDL is checked in.

## Local dev

### Frontend only (no Rust solver)

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>. No env required — falls back to the TS
coalition-enumeration solver and public upstreams.

### Full stack (with Rust Shapley solver)

You need two terminals:

```bash
# Terminal 1 — Shapley solver (Rust)
cd services/shapley-rs
cargo run
# → listening on http://localhost:8080
```

```bash
# Terminal 2 — Next.js frontend
SHAPLEY_SERVICE_URL=http://localhost:8080 npm run dev
# → listening on http://localhost:3000
```

The frontend detects `SHAPLEY_SERVICE_URL`, routes Shapley requests to
the Rust service, and labels responses `method: "lp-multi-commodity-flow-rs"`.
If the Rust service is unreachable, it falls back to the TS solver automatically.

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

### Optional env

Copy `.env.example` to `.env.local` and uncomment what you need:

```
SHAPLEY_SERVICE_URL=http://localhost:8080              # Rust solver (set automatically if running both terminals)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com     # for /api/onchain/*
DZ_REGISTRY_PROGRAM_ID=<pubkey>                        # pending DZ
DZ_REWARDS_PROGRAM_ID=<pubkey>                         # pending DZ
ONCHAIN_ENABLED=1                                      # toggle on-chain routes
NEXT_PUBLIC_SITE_URL=https://dz-contributor.vercel.app
```

## Deploy

### Frontend (Vercel)

`main` auto-deploys via Vercel's GitHub integration. No manual step.

### Rust solver

The service is a single container — build it with the provided
`services/shapley-rs/Dockerfile` and run it on any host or
orchestrator. It needs:

- `REDIS_URL` for the async job queue (optional — without it the
  synchronous endpoints still work and `/jobs/*` are disabled)
- `SHAPLEY_API_TOKEN` to require `Authorization: Bearer` on compute
  endpoints (strongly recommended for any internet-reachable deploy)
- optional S3-compatible object storage for the durable result cache
  (`S3_CACHE_BUCKET`, `S3_CACHE_ENDPOINT`, standard AWS env credentials)

```bash
cd services/shapley-rs
docker build -t dz-shapley-service .
docker run -p 8080:8080 -e SHAPLEY_API_TOKEN=$(openssl rand -hex 32) dz-shapley-service api
# worker role (one or more replicas), required for /jobs/*:
docker run -e REDIS_URL=... dz-shapley-service worker
```

After deploy, point `SHAPLEY_SERVICE_URL` in the frontend's env at the
service URL (and set the matching `SHAPLEY_API_TOKEN`).


## Tests + CI

GitHub Actions in `.github/workflows/`:

- `web.yml` — `next build` + `eslint` on every push
- `shapley-rs.yml` — `cargo build` + `cargo test` + `cargo clippy` for
  the Rust microservice on every push to `services/shapley-rs/**`

Solver correctness is pinned against the Foundation's reference:
`tests/upstream_simple.rs` matches the upstream `simple` example within
1%, `tests/link_estimate_http.rs` checks the per-link HTTP contract and
over-cap handling, and `tests/dedup_devices.rs` covers canonical device
handling. The engine itself (the `network-shapley-rs` fork) is
parity-tested against the Foundation's Python reference (`network_shapley`
and `network_linkestimate`). The smoke harness at `tests/smoke.sh`
re-validates the deployed service end-to-end.

## Pending external inputs

The site is fully functional but several layers go live the moment DZ
ships:

- **Program IDs + IDL** → flips on-chain routes from stub to live
- **Per-epoch payout feed** → flips reward-history charts from estimate to actual
- **Canonical demand + public-link tables** → flips Shapley from
  directional to bit-comparable


## License

Apache-2.0 (matching `network-shapley-rs`).
