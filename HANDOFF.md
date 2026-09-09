# Handoff

Start here to evaluate or take over DZ Contributor Rewards. This page says what is deployed, how the numbers are produced, how the code is tested, what the limits are and why, and what this repository leaves out. Every section links to the document that carries the detail.

## What is deployed

| Part | Where | Source |
|---|---|---|
| Frontend | <https://dzcontributor.xyz> | `main` of this repository, deployed by Vercel's GitHub integration |
| Shapley service | Reachable by the frontend only, over `SHAPLEY_SERVICE_URL` with a bearer token | `services/shapley-rs`, one container image, two processes (`--role=api`, `--role=worker`) |
| Solver engine | Compiled into the service | Fork of `doublezerofoundation/network-shapley-rs` at rev `bb5a24e0`, upstream base v0.6.0 |
| Job queue and result cache | Redis with streams, plus an S3-compatible bucket | Configured by the env vars in `docs/operations.md` sections 2 and 4 |
| Epoch data | One cron, `/api/link-value/precompute`, every six hours | Downloads each new epoch's snapshot once and publishes the baseline, the per-link values, and the diff shape from it |

Deployment for any container platform is in `docs/operations.md`. The platform, sizing, and hostnames we use are not part of this repository.

## What the numbers are

Reward shares are an exact Shapley value per source city, aggregated with stake weights. Responses carry the method label `lp-per-city-stake-weighted-exact`. Per-link values use the retag method: each focus-owned link becomes a player, every other operator collapses to one `Others` player, and one exact solve runs over `2^(links+1)` coalitions. Those responses carry `retag-shapley-rs`.

Nothing computes on a page load. The cron publishes each epoch's baseline under an epoch tag, and `/api/shapley`, `/api/shapley/baseline`, and `/api/shapley/tracking` read that alias or answer `404 {status:"not-cached"}`, which hides the widget. A service failure is a 502, never a different algorithm, and there is no in-process solver to fall back to. Details: `docs/shapley-pipeline.md` and `docs/adr/0004-cache-only-baseline-reads.md`.

The changelog runs the same way. Each epoch's topology is stored as a 28 KB shape record that the cron extracts from the snapshot it already downloads, so a diff between two epochs reads two small records instead of two 110 MB files. Details: `docs/adr/0003-cron-side-snapshot-extraction.md`.

## Tests and checks

| Where | What runs | What it compares |
|---|---|---|
| `.github/workflows/web.yml` | `pnpm lint`, `tsc --noEmit`, eight regression scripts, `pnpm build` | The frontend compiles and passes ESLint; the cron ingest, diff window, diff shape, repair schedule, baseline probe, tracking route, epoch tag, and sort state all hold |
| `.github/workflows/shapley-rs.yml` | `cargo fmt`, `cargo clippy`, `cargo test --release` against a Redis service container, container build | Service fixtures and HTTP contract tests, alias publication and single flight, the diff index's wire parity and conditional writes, in `services/shapley-rs/tests` |
| Engine CI (fork repository) | `just ci` | Engine suites in `tests/`; two of them compare `compute` and `network_link_estimate` output with the Foundation's Python implementation and run only when Python with pandas and scipy is present |
| `scripts/test-*.ts`, run with `pnpm test:<name>` | 23 `pnpm test:*` scripts | Input builders, the cron ingest, diff window and shape extraction, the repair schedule, the cache-only read routes and epoch tag, demand overrides, link edits, scenario URLs, epoch rate, the simulate progress estimator, validator stake and estimate, and the table sort state. Three decode live on-chain records and need `DZ_LEDGER_RPC_URL` |
| `lib/onchain/README.md` | Manual decode checks | Three on-chain readers decoded against the Foundation CLI output for recorded epochs |

The service keeps an epoch-149 input fixture for regression. That test is ignored by default and the fixture predates the current uptime-penalty model, so it is not a claim about on-chain results.

## Limits and why

| Limit | Value | Where enforced | Reason |
|---|---|---|---|
| Operators in a reward solve | 20 at full uptime, 15 when `operator_uptime` is below 1.0 (production uses 0.98) | Engine, `check_operator_limit` | The exact solve enumerates `2^operators` coalitions per city |
| Focus links on the sync `/link-estimate` route | 12 | Service, `SYNC_MAX_FOCUS_LINKS` | 8,192 coalitions at about 218 ms each (production worker logs, 4 solver threads) is about 30 minutes, so larger operators use the async path |
| Focus links for a per-link breakdown | 19 | Service, `SWEEP_MAX_FOCUS_LINKS`; frontend mirror `MAX_BREAKDOWN_FOCUS_LINKS` | Each link doubles the coalition count. At the measured rate 19 links is about 63 hours, longer than an epoch, so the page explains that no breakdown is available |
| Link players in the engine | 31 | Engine, `MAX_LINK_PLAYERS` | The coalition mask is a `u32` with one bit reserved |
| `/simulate` runtime | Minutes; recent runs show their typical time before you start one | Nothing to enforce | The scenario is user-defined, so results cannot be computed ahead of time. The baseline per epoch is cached |

Details: `docs/shapley-pipeline.md` (Limits) and `docs/shapley-service.md` (Input limits).

## Known gaps

- The progress screen on `/simulate` cannot tell a queued job from a solve that is still starting; both read as starting.
- `services/shapley-rs/tests/smoke.sh` step 8 calls `POST /diff/precompute`, a route the service does not serve. That step fails until the script is updated.
- Open engineering notes are in `services/shapley-rs/TODO.md`.

## Not included, on purpose

Hosting platform, instance sizing, hostnames, secrets, and internal ticket references stay out of this repository. The docs describe deployment for any container platform and any S3-compatible store. No statement here claims parity with DoubleZero's on-chain reward results.

## Documents

| Document | Read it for |
|---|---|
| `README.md` | Overview, route tables, quick start |
| `docs/architecture.md` | System diagram, layers, request flows, caching |
| `docs/data-sources.md` | Every upstream feed with URLs, cadences, and failure behaviour |
| `docs/shapley-pipeline.md` | Input builders, solver dispatch, the per-city and per-link methods, limits |
| `docs/shapley-service.md` | Service roles, auth, endpoints, job lifecycle, keyspace, cache |
| `docs/development.md` | Local setup, scripts, tests |
| `docs/operations.md` | Deployment on any container platform, env reference, CI, rotation, queue tooling |
| `docs/adr/0001-async-compute-queue.md` | Why long solves run as queued jobs, with amendments |
| `docs/adr/0002-snapshot-diff-index.md` | Why the epoch diff is served from immutable per-epoch records |
| `docs/adr/0003-cron-side-snapshot-extraction.md` | Why the cron extracts those records and the service needs no snapshot egress |
| `docs/adr/0004-cache-only-baseline-reads.md` | Why browser-driven Shapley reads never compute |
| `services/shapley-rs/README.md` | Service local development and testing |
