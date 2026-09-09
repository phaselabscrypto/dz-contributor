# Development

Local setup guide for the DZ Contributor Rewards tool — a Next.js 16 frontend and a Rust axum microservice (`services/shapley-rs/`).

## Prerequisites

| Tool | Version | Source |
|------|---------|--------|
| Node.js | 20 | `.github/workflows/web.yml` `setup-node` step |
| pnpm | 9.13.0 | `package.json` `packageManager` field |
| Rust nightly | `nightly-2026-05-26` | `services/shapley-rs/rust-toolchain.toml` and `.github/workflows/shapley-rs.yml` |
| Docker | any recent | optional — runs the local Redis (async `/jobs/*`) and MinIO (S3 result cache, aliases, diff shapes) from `services/shapley-rs/docker-compose.yml`; a native `minio` binary works too |

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

The app opens at `http://localhost:3000`. Without the Shapley microservice the Shapley, link-value, and diff routes return `503` and their widgets are not shown; there is no in-process fallback solver. See [shapley-pipeline.md](./shapley-pipeline.md) for a description of the full pipeline.

## Full stack (two terminals)

Running both the frontend and the Rust microservice together gives production-equivalent Shapley results.

**Terminal 1 — start the service:**

```sh
cd services/shapley-rs
SHAPLEY_ALLOW_UNAUTHENTICATED=1 cargo run
```

Without either `SHAPLEY_API_TOKEN` or `SHAPLEY_ALLOW_UNAUTHENTICATED=1`, the service starts but compute endpoints (`/shapley`, `/simulate`, `/link-estimate`, etc.) are **not served** — only `/health` is available. This is intentional fail-closed behaviour documented in `src/main.rs`. `SHAPLEY_ALLOW_UNAUTHENTICATED=1` is the local-dev opt-in; production sets `SHAPLEY_API_TOKEN` via a secret.

**Terminal 2 — start the frontend pointed at the service:**

```sh
SHAPLEY_SERVICE_URL=http://localhost:8080 pnpm dev
```

**Health check:**

```sh
curl localhost:8080/health
```

Returns `{"status":"ok","service":"dz-shapley-service","version":"<semver>"}` (fields defined in `src/model.rs` `HealthResponse`).

### Async jobs (Redis)

The `/jobs/*` and `/precompute*` endpoints require Redis. Without `REDIS_URL`, the submit endpoints return `503 {"error":"async jobs disabled (REDIS_URL not configured)"}` and the poll/cancel endpoints return `503 {"error":"async jobs disabled"}`. Synchronous compute endpoints are unaffected.

`services/shapley-rs/docker-compose.yml` provides a Redis 7.4.1 instance and a MinIO instance for local testing. It does not build the service itself (the Cargo workspace uses a path dependency on a sibling repo that is outside the Docker build context — see the compose file header comment).

```sh
cd services/shapley-rs
docker compose up -d          # Redis on host port 6390 (password "devpass") + MinIO on :9000 / console :9001
```

Then run the API and worker roles on the host, each in its own terminal:

```sh
# Terminal 1 — API role (port 8099 avoids a conflict with a plain `cargo run`)
PORT=8099 REDIS_URL=redis://:devpass@127.0.0.1:6390 \
  SHAPLEY_ALLOW_UNAUTHENTICATED=1 cargo run -- api

# Terminal 2 — worker role (required; without it jobs stay in state=running)
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

### S3 cache, baselines, and diff shapes (MinIO)

Everything the site reads from the service on a page load lives in the S3-compatible bucket: published epoch baselines (`GET /shapley/baseline?tag=`), precomputed link estimates, simulate results, and the diff shapes behind `/changelog`. Without `S3_CACHE_BUCKET` the service still solves, but every baseline read is `404 not-cached`, `PUT /diff/shape` answers 503, and nothing survives a restart. To exercise those paths locally, create a bucket in MinIO once and start both roles with the S3 env; the exact commands are in `services/shapley-rs/README.md` under "Local S3 testing".

To populate it the way production does, run the cron route against your local stack with a manual epoch:

```sh
CRON_SECRET=dev SHAPLEY_SERVICE_URL=http://localhost:8099 SHAPLEY_INGEST_TOKEN=dev pnpm dev
curl -H "Authorization: Bearer dev" "http://localhost:3000/api/link-value/precompute?epoch=<N>"
```

The service must be started with the matching `SHAPLEY_INGEST_TOKEN=dev`. A full epoch is a ~110 MB download plus a production-size solve on the worker (minutes on a laptop); see [operations.md](./operations.md#precompute-cron-apilink-valueprecompute) for what one fire does.

## Repo layout

```
.
├── app/                        # Next.js app router
│   ├── api/                    # 31 API route handlers (incl. the link-value/precompute cron)
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
│   ├── utils/                  # canonical input builder, Shapley client, cron ingest, diff shape, …
│   └── utils.ts
├── services/
│   └── shapley-rs/             # Rust axum microservice
│       ├── src/
│       │   ├── main.rs         # server entry, role dispatch, auth + ingest middleware
│       │   ├── routes.rs       # HTTP handlers, per-city Shapley, baseline alias read, job submit
│       │   ├── inflight.rs     # per-process single flight for cold /shapley solves
│       │   ├── jobs.rs         # Redis job store (create/progress/cancel/done)
│       │   ├── queue.rs        # stream keys, entry schema, hash helpers
│       │   ├── worker.rs       # Redis Stream consume loop, sweep fan-out, alias publication
│       │   ├── cache.rs        # in-memory + S3 result cache, aliases, sweep markers
│       │   ├── diff.rs         # DiffShape + pure diff computations
│       │   ├── diff_store.rs   # diff/v1 shape store (conditional S3 writes, missing-epoch probe)
│       │   ├── diff_routes.rs  # /diff, /diff/contributor, /diff/missing, PUT /diff/shape
│       │   ├── diff_error.rs   # diff error → HTTP status mapping
│       │   ├── epoch.rs        # epoch newtype + window bounds
│       │   ├── model.rs        # wire types (JSON ↔ crate types)
│       │   └── lib.rs          # crate root, AppState
│       ├── tests/              # integration + parity tests, MockS3 support, smoke script
│       ├── Dockerfile
│       ├── docker-compose.yml  # dev-only Redis + MinIO
│       └── rust-toolchain.toml
├── scripts/                    # test scripts (pnpm test:*), backfill, parity fixtures (see table below)
├── types/                      # shared TypeScript type declarations
├── public/                     # static assets
├── .github/workflows/
│   ├── web.yml                 # lint + typecheck + regression scripts + build
│   └── shapley-rs.yml          # Rust fmt + clippy + test (with Redis) + Docker build
├── eslint.config.mjs
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.json
```

## Scripts inventory

Scripts live in `scripts/`. Run those with `.ts` extensions through their `package.json` alias (the aliases invoke `tsx` directly) or manually with `npx tsx <script>`. The `.sh` file is a standalone bash utility.

| Script | pnpm alias | Purpose |
|--------|-----------|---------|
| `scripts/validate-shapley.ts` | `pnpm validate` | Reads `/api/shapley?epoch=N` for a range of epochs and writes a `validation-report.md` comparing solver shares against on-chain payouts; an epoch the cron has not published answers 404 and is skipped |
| `scripts/test-precompute-ingest.ts` | `pnpm test:precompute-ingest` | Drives `runPrecomputeIngest` against a stubbed service and snapshot: already-swept short-circuit, sweep + baseline + shape from one download, alias-only publish, shape failure, work-budget exhaustion, history repair |
| `scripts/test-diff-repair-schedule.ts` | `pnpm test:diff-repair-schedule` | Pure check of `scheduleDiffRepairs`: current epoch first, newest gap next, rotation by 6-hour slot |
| `scripts/test-diff-window.ts` | `pnpm test:diff-window` | Window-validation parity between `lib/utils/diff-window.ts` and the Rust `validate_window` (same bounds, same three messages) |
| `scripts/test-diff-shape-offline.ts` | `pnpm test:diff-shape-offline` | Pure `extractDiffShape` contract: only the four serviceability sections, insertion order preserved, unknown contributor code |
| `scripts/test-diff-shape.ts` | `pnpm test:diff-shape` | Regenerates or checks the epoch 204–211 shapes under `services/shapley-rs/tests/fixtures/diff/shapes/` that `diff_parity.rs` pins; `-- --write` rewrites them; needs the snapshots |
| `scripts/backfill-diff-shapes.ts` | `pnpm backfill:diff` | One-off deep-history fill of the diff index, newest first, one epoch at a time; `--dry-run` reports gaps; needs `SHAPLEY_SERVICE_URL`, `SHAPLEY_API_TOKEN`, `SHAPLEY_INGEST_TOKEN` |
| `scripts/test-baseline-tag.ts` | `pnpm test:baseline-tag` | Pure check of `baselineTag(epoch)`: shape, determinism, epoch-distinctness, query-string round trip |
| `scripts/test-baseline-probe.ts` | `pnpm test:baseline-probe` | Drives `/api/shapley/baseline` and `/api/shapley?epoch=N` against a stubbed service: hit, miss, upstream failure, legacy 404, probe timeout |
| `scripts/test-baseline-route.ts` | `pnpm test:baseline` | HTTP contract of a running `/api/shapley/baseline`: 200 published shape or 404 `not-cached`, never a compute |
| `scripts/test-tracking-route.ts` | `pnpm test:tracking-route` | Drives `/api/shapley/tracking` and the pure `pivotTracking` against a stubbed service: partial cache, too few hits, probe failure, count clamping |
| `scripts/test-validator-stake.ts` | `pnpm test:stake` | Pubkey validation, vote-account stake resolution (filtered lookup, identity index), and the `/api/validators/stake` route contract |
| `scripts/test-validator-estimate.ts` | `pnpm test:estimate` | Validator earnings math (`reward-estimator.ts`) parity against `scripts/fixtures/validator-rewards-expected.json` |
| `scripts/test-epoch-rate.ts` | `pnpm test:epoch-rate` | Epoch-cadence derivation and plausibility clamp; a live section measures a real RPC |
| `scripts/test-simulate-eta.ts` | `pnpm test:simulate-eta` | Rolling ETA estimator, duration copy, and per-browser run history for the simulate progress UI |
| `scripts/test-scenario-url.ts` | `pnpm test:scenario-url` | Shareable scenario URL codec: encode/decode round trips and garbage-in handling |
| `scripts/test-link-edits.ts` | `pnpm test:links` | Link-edit normalization and snapshot-aware validation; needs a local snapshot |
| `scripts/test-demand-overrides.ts` | `pnpm test:demand` | Demand-override normalization and DZ-parity invariants; needs a local snapshot |
| `scripts/test-coverage-gaps.ts` | `pnpm test:coverage-gaps` | "Suggested routes" coverage-gap invariants (`findCoverageGaps`) |
| `scripts/test-sort-state.ts` | `pnpm test:sort-state` | Table sort-state reducer (stored vs effective key) |
| `scripts/test-borsh-registry.ts` | `pnpm test:borsh` | Round-trip borsh encode/decode against the schemas in `lib/onchain/idl/schemas.ts`; regression pin for the borsh registry |
| `scripts/test-canonical-parity.ts` | `pnpm test:canonical` | Diffs the TS canonical input builder against DZ's Python reference builder over the same snapshot; requires a local snapshot file |
| `scripts/parity-build-input.ts` | — | Builds the canonical `ShapleyInput` from a raw snapshot and prints a summary for diffing against DZ's `inspect shapley`; `PARITY_EPOCH149=1` forces the historical params |
| `scripts/decode-live-rewards.ts` | `pnpm test:onchain` | Fetches a live contributor-rewards record from the DZ ledger and decodes it through the TS reader; requires `DZ_LEDGER_RPC_URL` |
| `scripts/verify-derive-and-decode.ts` | `pnpm test:derive` | Derives the epoch-117 contributor-rewards address from seeds and asserts the decoded header matches known-good values; requires `DZ_LEDGER_RPC_URL` |
| `scripts/verify-contributor-directory.ts` | `pnpm test:directory` | Fetches all Contributor accounts from the DZ serviceability program and checks known (owner → code) pairs from the epoch-117 reference; requires `DZ_LEDGER_RPC_URL` |
| `scripts/gen-epoch149-parity-fixture.ts` | — | Generates `services/shapley-rs/tests/fixtures/epoch149/input.json` and `expected_leaves.json` for the Rust parity guardrail; requires `DZ_LEDGER_RPC_URL` |
| `scripts/queue-clear.sh` | — | Clears the Redis work queue in `--surgical` mode (drops backlog, keeps state/cache) or `--nuke` mode (full keyspace wipe); requires a running Redis accessible via `REDIS_URL` |

The pure scripts (`precompute-ingest`, `diff-repair-schedule`, `diff-window`, `diff-shape-offline`, `baseline-probe`, `tracking-route`, `baseline-tag`, `sort-state`) run in CI on every push; the rest need a snapshot, an RPC, or a running server.

## Testing

### Rust (run from `services/shapley-rs/`)

| What | Command | Notes |
|------|---------|-------|
| Unit + integration tests | `TEST_REDIS_URL=redis://127.0.0.1:6390/13 cargo test --locked` | Covers `upstream_simple`, `dedup_devices`, `link_estimate_http`, `link_estimate_alias`, `baseline_alias_http`, `shapley_single_flight`, `diff_parity`, `diff_persistence`, the in-crate unit tests, and `alias_publication`, which needs an **empty** Redis database at `TEST_REDIS_URL` on `127.0.0.1`/`localhost` (the test panics when the variable is unset, refuses an occupied database, and cleans up after itself). The S3 tests run against the in-process `MockS3` in `tests/support/mod.rs`; no bucket needed. CI runs with `--release` against a Redis service container |
| Three-operator structural test | `cargo test --test three_operator` | Currently `#[ignore]` pending fixture reshape; see `tests/three_operator.rs` |
| Gateway conditional-write acceptance | `cargo test --locked --test diff_persistence gateway_conditional_contract -- --ignored --nocapture` | Needs `TEST_S3_ENDPOINT` + a disposable `TEST_S3_BUCKET`; run before deploying against a new object gateway (see [operations.md](./operations.md#alias-publication-rollout)) |
| Timing probe (link-estimate at production scale) | `cargo test --release --test linkest_timing -- --ignored --nocapture` | Requires `tests/fixtures/epoch149/input.json`; prints timing per operator |
| Full epoch-149 reward-leaf parity | `cargo test --test parity_epoch149 -- --ignored --nocapture` | `#[ignore]` — heavy per-city LP solve; skips gracefully when fixture is absent. Generate the fixture first with `DZ_LEDGER_RPC_URL=... npx tsx scripts/gen-epoch149-parity-fixture.ts` |
| E2E smoke against a running service | `cd services/shapley-rs && SHAPLEY_API_TOKEN=… ./tests/smoke.sh [url]` | Defaults to `http://localhost:8080`; checks `/health`, `/shapley` (simple + three-operator fixtures), `/link-estimate`, `/diff` and `/diff/contributor/tsw` over epochs 204–211 (needs those shapes in the bucket), the `/shapley/baseline` miss contract, and a latency budget; requires `curl`, `jq`, `python3` |

### Frontend

| What | Command | Notes |
|------|---------|-------|
| Lint | `pnpm lint` | ESLint flat config (`eslint.config.mjs`) with Next.js core-web-vitals + TypeScript rules |
| Typecheck | `pnpm exec tsc --noEmit --incremental false` | What CI runs before the regression scripts |
| Regression scripts | `pnpm test:<name>` | See the scripts inventory; the eight pure ones run in CI |
| Production build | `pnpm build` | CI sets `NODE_ENV=production` to suppress upstream fetches during prerender |

### CI parity

`.github/workflows/web.yml` runs, on Node 20: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm exec tsc --noEmit --incremental false`, the eight pure regression scripts (`test:diff-window`, `test:diff-repair-schedule`, `test:precompute-ingest`, `test:diff-shape-offline`, `test:baseline-probe`, `test:tracking-route`, `test:baseline-tag`, `test:sort-state`), then `pnpm build` with `NODE_ENV=production`. Reproduce locally with the same commands. Node 20 matters: `instanceof` checks across dynamically imported `tsx` modules behave differently on newer Node, so run the scripts under Node 20 before pushing.

`.github/workflows/shapley-rs.yml` runs (from `services/shapley-rs/`, with a `redis:7.4.1` service container and `TEST_REDIS_URL=redis://127.0.0.1:6379/13`): `cargo fmt --all -- --check` (advisory, non-blocking), `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked --release`. A separate `docker` job runs `docker build` as a smoke test after the tests pass. Reproduce locally:

```sh
cd services/shapley-rs
docker compose up -d redis          # or any empty Redis
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

For the async job queue design, see [adr/0001-async-compute-queue.md](./adr/0001-async-compute-queue.md); for the cron-side snapshot extraction and the cache-only read routes, see [adr/0003](./adr/0003-cron-side-snapshot-extraction.md) and [adr/0004](./adr/0004-cache-only-baseline-reads.md).
