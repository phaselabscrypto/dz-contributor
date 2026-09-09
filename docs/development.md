# Development

Local setup guide for the DZ Contributor Rewards tool: a Next.js 16 frontend and a Rust axum microservice (`services/shapley-rs/`).

## Prerequisites

| Tool | Version | Source |
|------|---------|--------|
| Node.js | 20 | `.github/workflows/web.yml` `setup-node` step |
| pnpm | 9.13.0 | `package.json` `packageManager` field |
| Rust nightly | `nightly-2026-05-26` | `services/shapley-rs/rust-toolchain.toml` and `.github/workflows/shapley-rs.yml` |
| Docker | any recent | optional, only needed to run the local Redis for `/jobs/*` async endpoints |

Install the Rust toolchain with:

```sh
rustup toolchain install nightly-2026-05-26
rustup component add rustfmt clippy --toolchain nightly-2026-05-26
```

`rust-toolchain.toml` pins the toolchain so `cargo` inside `services/shapley-rs/` picks it up automatically.

## Frontend-only quickstart

No environment variables are required to run the frontend alone.

```sh
pnpm install
pnpm dev
```

The app opens at `http://localhost:3000`. Without the Shapley microservice the Shapley, link-value, and diff routes answer `503` and their cards render nothing. There is no in-process solver. See [shapley-pipeline.md](./shapley-pipeline.md) for the full pipeline.

## Full stack (two terminals)

Running both the frontend and the Rust microservice together gives production-equivalent Shapley results.

**Terminal 1, start the service:**

```sh
cd services/shapley-rs
SHAPLEY_ALLOW_UNAUTHENTICATED=1 cargo run
```

Without either `SHAPLEY_API_TOKEN` or `SHAPLEY_ALLOW_UNAUTHENTICATED=1`, the service starts but compute endpoints (`/shapley`, `/simulate`, `/link-estimate`, etc.) are **not served**; only `/health` is available. This is intentional fail-closed behaviour documented in `src/main.rs`. `SHAPLEY_ALLOW_UNAUTHENTICATED=1` is the local-dev opt-in; production sets `SHAPLEY_API_TOKEN` via a secret.

**Terminal 2, start the frontend pointed at the service:**

```sh
SHAPLEY_SERVICE_URL=http://localhost:8080 pnpm dev
```

**Health check:**

```sh
curl localhost:8080/health
```

Returns `{"status":"ok","service":"dz-shapley-service","version":"<semver>"}` (fields defined in `src/model.rs` `HealthResponse`).

### Async jobs (Redis)

The `/jobs/*` endpoints require Redis. Without `REDIS_URL`, the submit endpoints return `503 {"error":"async jobs disabled (REDIS_URL not configured)"}` and the poll/cancel endpoints return `503 {"error":"async jobs disabled"}`. Synchronous compute endpoints are unaffected.

`services/shapley-rs/docker-compose.yml` provides a Redis 7.4.1 instance for local async testing and a MinIO instance for the optional S3 result cache (see [Local S3 cache](#local-s3-cache) below). It does not build the service itself (the Cargo workspace uses a path dependency on a sibling repo that is outside the Docker build context; see the compose file header comment).

```sh
cd services/shapley-rs
docker compose up -d          # starts Redis on host port 6390 with password "devpass"
```

Then run the API and worker roles on the host, each in its own terminal:

```sh
# Terminal 1: API role (port 8099 avoids a conflict with a plain `cargo run`)
PORT=8099 REDIS_URL=redis://:devpass@127.0.0.1:6390 \
  SHAPLEY_ALLOW_UNAUTHENTICATED=1 cargo run -- api

# Terminal 2: worker role (required; without it jobs stay in state=running)
PORT=8098 REDIS_URL=redis://:devpass@127.0.0.1:6390 cargo run -- worker
```

Point the frontend at the API:

```sh
SHAPLEY_SERVICE_URL=http://localhost:8099 pnpm dev
```

Teardown:

```sh
docker compose down
```

### Local S3 cache

The bucket holds everything the site reads from the service on a page load: the published epoch baselines behind `GET /shapley/baseline?tag=`, the precomputed link estimates, the simulate results that make a shared forecast URL return instantly, and the diff shapes behind the changelog. It targets any S3-compatible endpoint through `S3_CACHE_ENDPOINT` (path-style addressing), so MinIO models production faithfully. Without `S3_CACHE_BUCKET` the service still solves, but every baseline read is `404 not-cached`, sweep status is always incomplete, `PUT /diff/shape` answers 503, and nothing survives a restart.

```sh
cd services/shapley-rs
docker compose up -d minio     # or: minio server /tmp/minio-data --address :9000

# one-time: create the bucket
AWS_ACCESS_KEY_ID=devaccess AWS_SECRET_ACCESS_KEY=devsecret123 \
  aws --endpoint-url http://127.0.0.1:9000 s3 mb s3://shapley-cache
```

Run both roles with the S3 env added (same variables for api and worker):

```sh
# Terminal 1: API role
S3_CACHE_BUCKET=shapley-cache S3_CACHE_ENDPOINT=http://127.0.0.1:9000 \
AWS_ACCESS_KEY_ID=devaccess AWS_SECRET_ACCESS_KEY=devsecret123 AWS_REGION=us-east-1 \
PORT=8099 REDIS_URL=redis://:devpass@127.0.0.1:6390 \
  SHAPLEY_ALLOW_UNAUTHENTICATED=1 cargo run -- api

# Terminal 2: worker role, same S3 env
S3_CACHE_BUCKET=shapley-cache S3_CACHE_ENDPOINT=http://127.0.0.1:9000 \
AWS_ACCESS_KEY_ID=devaccess AWS_SECRET_ACCESS_KEY=devsecret123 AWS_REGION=us-east-1 \
PORT=8098 REDIS_URL=redis://:devpass@127.0.0.1:6390 cargo run -- worker
```

A corrupt cached object is treated as a miss, recomputed, and re-stored. Clear a stuck queue with `scripts/queue-clear.sh` (repo root): `--surgical` drops queued and pending entries and recreates the consumer group in place (worker keeps running, results kept); `--nuke` wipes the whole `shapley:whatif:*` keyspace and needs a worker restart.

## Repo layout

```
.
├── app/                        # Next.js app router
│   ├── api/                    # 31 API route handlers, including the link-value/precompute cron
│   └── ...                     # 15 page routes (contributors, simulate, economics, …)
├── components/                 # React components, feature-grouped
│   ├── contributors/
│   ├── economics/
│   ├── header.tsx
│   ├── links/
│   ├── network/
│   ├── section-heading.tsx
│   ├── simulator/
│   ├── ui/                     # shared primitives (Radix-backed)
│   └── validators/
├── lib/                        # shared TypeScript
│   ├── constants/
│   ├── hooks/
│   ├── observability.ts
│   ├── onchain/                # Solana account derivation + borsh readers
│   ├── types/
│   ├── utils/                  # canonical input builder, Shapley client, …
│   └── utils.ts
├── services/
│   └── shapley-rs/             # Rust axum microservice
│       ├── src/
│       │   ├── main.rs         # server entry, role dispatch, auth middleware
│       │   ├── routes.rs       # HTTP handlers + per-city Shapley logic
│       │   ├── jobs.rs         # Redis job store (create/progress/cancel/done)
│       │   ├── queue.rs        # stream keys, entry schema, hash helpers
│       │   ├── worker.rs       # Redis Stream consume loop
│       │   ├── cache.rs        # in-memory + S3 result cache
│       │   ├── model.rs        # wire types (JSON ↔ crate types)
│       │   └── lib.rs          # crate root, AppState
│       ├── tests/              # integration + parity tests + smoke script
│       ├── Dockerfile
│       ├── docker-compose.yml  # local Redis + MinIO
│       └── rust-toolchain.toml
├── scripts/                    # dev/validation scripts (see table below)
├── types/                      # shared TypeScript type declarations
├── public/                     # static assets
├── .github/workflows/
│   ├── web.yml                 # lint + typecheck + regression scripts + build
│   └── shapley-rs.yml          # Rust fmt + clippy + test + Docker build CI
├── eslint.config.mjs
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.json
```

## Scripts inventory

Scripts live in `scripts/`. Run those with `.ts` extensions through their `package.json` alias (the aliases invoke `tsx` directly) or manually with `npx tsx <script>`. The `.sh` file is a standalone bash utility.

| Script | pnpm alias | Purpose |
|--------|-----------|---------|
| `next dev` | `pnpm dev` | Starts the Next.js dev server |
| `next build` | `pnpm build` | Production build; also the project's typecheck (see [Testing](#testing)) |
| `next start` | `pnpm start` | Serves the production build made by `pnpm build` |
| `eslint` | `pnpm lint` | Runs ESLint over the repo (`eslint.config.mjs`, see [Testing](#testing)) |
| `scripts/validate-shapley.ts` | `pnpm validate` | Hits `/api/shapley?epoch=N` for a range of epochs and writes a `validation-report.md` comparing solver shares against on-chain payouts. An epoch the cron has not published answers 404 and is skipped |
| `scripts/test-borsh-registry.ts` | `pnpm test:borsh` | Round-trip borsh encode/decode against the schemas in `lib/onchain/idl/schemas.ts`; regression pin for the borsh registry |
| `scripts/test-canonical-parity.ts` | `pnpm test:canonical` | Diffs the TS canonical input builder against DZ's Python reference builder over the same snapshot; requires a local snapshot file |
| `scripts/test-demand-overrides.ts` | `pnpm test:demand` | Demand-override invariants: normalize + apply-by-regeneration against a real snapshot (`lib/utils/demand-overrides.ts`) |
| `scripts/test-coverage-gaps.ts` | `pnpm test:coverage-gaps` | Coverage-gap suggestion invariants for `findCoverageGaps` (`lib/utils/demand.ts`) |
| `scripts/test-link-edits.ts` | `pnpm test:links` | Link-edit validation: normalize + snapshot-aware checks against a real snapshot (`lib/utils/link-edits.ts`) |
| `scripts/test-scenario-url.ts` | `pnpm test:scenario-url` | Scenario-URL codec round-trips and garbage-in handling (`lib/utils/scenario-url.ts`) |
| `scripts/test-baseline-route.ts` | `pnpm test:baseline` | HTTP contract of a running `/api/shapley/baseline`: either 200 with the published shape or 404 `not-cached`, and never a compute |
| `scripts/test-precompute-ingest.ts` | `pnpm test:precompute-ingest` | The cron fire against a stubbed service and snapshot: already-swept short-circuit, sweep plus baseline plus shape from one download, alias-only publish, shape failure, budget exhaustion, history repair |
| `scripts/test-diff-repair-schedule.ts` | `pnpm test:diff-repair-schedule` | `scheduleDiffRepairs`: current epoch first, newest gap next, rotation by six-hour slot |
| `scripts/test-diff-window.ts` | `pnpm test:diff-window` | Window-validation parity between `lib/utils/diff-window.ts` and the Rust `validate_window`: same bounds, same three messages |
| `scripts/test-diff-shape-offline.ts` | `pnpm test:diff-shape-offline` | `extractDiffShape` contract: only the four serviceability sections, insertion order preserved, unknown contributor code |
| `scripts/test-diff-shape.ts` | `pnpm test:diff-shape` | Checks or regenerates the epoch 204-211 shapes that `diff_parity.rs` pins; `-- --write` rewrites them; needs the snapshots |
| `scripts/backfill-diff-shapes.ts` | `pnpm backfill:diff` | Fills the diff index's deep history, newest first, one epoch at a time; `--dry-run` reports gaps. Needs `SHAPLEY_SERVICE_URL`, `SHAPLEY_API_TOKEN`, `SHAPLEY_INGEST_TOKEN` |
| `scripts/test-baseline-probe.ts` | `pnpm test:baseline-probe` | `/api/shapley/baseline` and `/api/shapley?epoch=N` against a stubbed service: hit, miss, upstream failure, a 404 without a `not-cached` body, probe timeout |
| `scripts/test-baseline-tag.ts` | `pnpm test:baseline-tag` | `baselineTag(epoch)`: shape, determinism, epoch-distinctness, query-string round trip |
| `scripts/test-tracking-route.ts` | `pnpm test:tracking-route` | `/api/shapley/tracking` and the pure `pivotTracking`: partial cache, too few hits, probe failure, count clamping |
| `scripts/test-sort-state.ts` | `pnpm test:sort-state` | Table sort-state reducer: stored key versus effective key after fallback |
| `scripts/decode-live-rewards.ts` | `pnpm test:onchain` | Fetches a live contributor-rewards record from the DZ ledger and decodes it through the TS reader; requires `DZ_LEDGER_RPC_URL` |
| `scripts/verify-derive-and-decode.ts` | `pnpm test:derive` | Derives the epoch-117 contributor-rewards address from seeds and asserts the decoded header matches known-good values; requires `DZ_LEDGER_RPC_URL` |
| `scripts/verify-contributor-directory.ts` | `pnpm test:directory` | Fetches all Contributor accounts from the DZ serviceability program and checks known (owner → code) pairs from the epoch-117 reference; requires `DZ_LEDGER_RPC_URL` |
| `scripts/test-epoch-rate.ts` | `pnpm test:epoch-rate` | Epoch-rate derivation and plausibility-clamp checks (`lib/utils/epoch-rate.ts`); pure by default, or `LIVE=1` with `SOLANA_RPC_URL` for a live RPC measurement |
| `scripts/test-simulate-eta.ts` | `pnpm test:simulate-eta` | Tests the rolling ETA estimator, duration copy, and per-browser run history (`lib/utils/eta.ts`, `lib/utils/format.ts`, `lib/utils/run-history.ts`) |
| `scripts/test-validator-stake.ts` | `pnpm test:stake` | Tests pubkey validation, vote-account stake resolution, and the stake route (`lib/utils/pubkey.ts`, `lib/onchain/vote-stake.ts`, `app/api/validators/stake/route.ts`); the live section against a real RPC is opt-in |
| `scripts/test-validator-estimate.ts` | `pnpm test:estimate` | Validator earnings math tests for `computeValidatorRewards` and `estimateValidatorTake` (`lib/utils/reward-estimator.ts`); pure, pinned to the fallback epoch rate |
| `scripts/gen-epoch149-parity-fixture.ts` | n/a | Generates `services/shapley-rs/tests/fixtures/epoch149/input.json` and `expected_leaves.json` for the Rust parity guardrail; requires `DZ_LEDGER_RPC_URL` |
| `scripts/parity-build-input.ts` | n/a | Builds the canonical `ShapleyInput` from a raw snapshot and writes it out, for diffing against DZ's own reference builder; run manually with `npx tsx scripts/parity-build-input.ts <snapshot.json> <out.json>` |
| `scripts/queue-clear.sh` | n/a | Clears the Redis work queue in `--surgical` mode (drops backlog, keeps state/cache) or `--nuke` mode (full keyspace wipe); requires a running Redis accessible via `REDIS_URL` |

## Testing

### Rust (run from `services/shapley-rs/`)

| What | Command | Notes |
|------|---------|-------|
| Unit + integration tests | `TEST_REDIS_URL=redis://:devpass@127.0.0.1:6390/13 cargo test --locked` | Covers `upstream_simple`, `dedup_devices`, `link_estimate_http`, `link_estimate_alias`, `baseline_alias_http`, `shapley_single_flight`, `diff_parity`, `diff_persistence`, the in-crate unit tests, and `alias_publication`, which needs an empty Redis database on `127.0.0.1` or `localhost` at `TEST_REDIS_URL`. It panics when that is unset, refuses an occupied database, and cleans up after itself. The S3 tests use the in-process `MockS3` in `tests/support/mod.rs`, so no bucket is needed. CI runs with `--release` |
| Three-operator structural test | `cargo test --test three_operator` | `#[ignore]`; see `tests/three_operator.rs` |
| Gateway conditional-write acceptance | `cargo test --locked --test diff_persistence gateway_conditional_contract -- --ignored --nocapture` | Needs `TEST_S3_ENDPOINT` and a disposable `TEST_S3_BUCKET`. Run it before deploying against a new object gateway; see [operations.md](./operations.md#object-gateway-acceptance-test) |
| Timing probe (link-estimate at production scale) | `cargo test --release --test linkest_timing -- --ignored --nocapture` | Requires `tests/fixtures/epoch149/input.json`; prints timing per operator |
| Full epoch-149 reward-leaf parity | `cargo test --test parity_epoch149 -- --ignored --nocapture` | `#[ignore]`: heavy per-city LP solve; skips gracefully when fixture is absent. Generate the fixture first with `DZ_LEDGER_RPC_URL=... npx tsx scripts/gen-epoch149-parity-fixture.ts` |
| E2E smoke against a running service | `cd services/shapley-rs && ./tests/smoke.sh [url]` | Defaults to `http://localhost:8080`; checks `/health`, `/shapley` (simple + three-operator fixtures), `/link-estimate`, and a latency budget; requires `curl`, `jq`, `python3` |

### Frontend

| What | Command | Notes |
|------|---------|-------|
| Lint | `pnpm lint` | ESLint flat config (`eslint.config.mjs`) with Next.js core-web-vitals + TypeScript rules |
| Production build | `pnpm build` | Also acts as a typecheck; CI sets `NODE_ENV=production` to suppress upstream fetches during prerender |

### CI parity

`.github/workflows/web.yml` runs, on Node 20: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm exec tsc --noEmit --incremental false`, eight regression scripts (`test:diff-window`, `test:diff-repair-schedule`, `test:precompute-ingest`, `test:diff-shape-offline`, `test:baseline-probe`, `test:tracking-route`, `test:baseline-tag`, `test:sort-state`), then `pnpm build` with `NODE_ENV=production`. Reproduce locally with the same commands. Node 20 matters: `instanceof` across dynamically imported `tsx` modules behaves differently on newer Node, so run the scripts under Node 20 before pushing.

`.github/workflows/shapley-rs.yml` runs from `services/shapley-rs/`, with a `redis:7.4.1` service container and `TEST_REDIS_URL=redis://127.0.0.1:6379/13`: `cargo fmt --all -- --check` (advisory, non-blocking), `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked --release`. A separate `docker` job runs `docker build` as a smoke test after the tests pass. Reproduce locally:

```sh
cd services/shapley-rs
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
TEST_REDIS_URL=redis://:devpass@127.0.0.1:6390/13 cargo test --locked --release
```

## Conventions

### TypeScript

`tsconfig.json` enables `strict`, sets the `@/*` path alias (root of the repo), and excludes `services/**` so Rust files under `target/` are never parsed by the TypeScript compiler.

### ESLint

`eslint.config.mjs` uses a flat config with `eslint-config-next` core-web-vitals and TypeScript rules. It explicitly ignores `.next/**`, `out/**`, `build/**`, `next-env.d.ts`, and `services/**/target/**` (the last entry prevents Cargo's CMake artefacts from being linted as TypeScript).

### Supply-chain hardening

`pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7 days in minutes) so pnpm rejects packages published less than seven days before they would land in the lockfile, giving the community time to detect compromised releases.

`package.json` `pnpm.overrides` pins two known-vulnerable transitive ranges: `d3-color@<3.1.0` → `>=3.1.0` and `postcss@<8.5.10` → `>=8.5.10`.

---

For production deployment and the full environment-variable reference, see [operations.md](./operations.md).

For data-source details, see [data-sources.md](./data-sources.md).

For the async job queue and worker internals, see [shapley-service.md](./shapley-service.md).
