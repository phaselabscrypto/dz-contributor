# Operations

Deployment and configuration reference for the DZ Contributor Rewards stack: a Next.js frontend deployed on Vercel, a Rust Shapley microservice run as a container, Redis for async job queuing, and an optional S3-compatible result cache.

For local development setup see [development.md](development.md). For service internals see [shapley-service.md](shapley-service.md).

---

## 1. Frontend (Vercel)

The reference deployment runs at `https://dzcontributor.xyz`, built by Vercel's GitHub integration from the `main` branch of `phaselabscrypto/dz-contributor`. Every push to `main` triggers a new deploy.

### First-time setup

1. Import the repository into Vercel as a new project.
2. Set every environment variable marked "Required in production" in Section 3.
3. Vercel reads the cron schedule from `vercel.json` and activates both crons automatically. No extra configuration is needed.
4. Set your custom domain in the Vercel project settings.

### Cron jobs

Two cron schedules are defined in `vercel.json`:

| Path | Schedule | Purpose |
|------|----------|---------|
| `/api/health` | `*/15 * * * *` (every 15 min) | Keep the function instance warm; also used by the `/status` page |
| `/api/link-value/precompute` | `0 */6 * * *` (every 6 hours) | One snapshot download for the latest epoch, feeding the link-value sweep, the baseline alias, and the diff shape; then repair historical diff-shape gaps |

### Precompute cron (`/api/link-value/precompute`)

This is the only route that asks the service to compute. Every user-facing Shapley read is cache-only, so if this cron stops, the site stops gaining new epochs. `app/api/link-value/precompute/route.ts` handles auth and `runPrecomputeIngest` in `lib/utils/precompute-ingest.ts` does the work.

**Auth.** Vercel sends `Authorization: Bearer ${CRON_SECRET}` on cron invocations. `bearerMatches` in `lib/utils/cron-auth.ts` compares it with `timingSafeEqual`; the equal-length pre-check it needs reveals token length, never content. An unset `CRON_SECRET` returns `503`, a mismatch `401`. Writes to the service carry a second token, `SHAPLEY_INGEST_TOKEN`, as `X-Ingest-Token`.

**What one fire does.** It resolves the latest epoch, then probes three things in the service:

| Probe | Answers |
|---|---|
| `GET /precompute/link-estimates/status?tag=` | is the epoch fully swept |
| `GET /shapley/baseline?tag=` | is the baseline alias published |
| `GET /diff/missing?latest=&depth=31` | which of the last 31 epochs lack a diff shape |

A steady-state fire finds all three satisfied and returns `{sweep: "already-swept"}` in seconds. It downloads nothing.

Otherwise it downloads the epoch snapshot once and builds the canonical Shapley input from it. That one download feeds three writes: `POST /precompute/link-estimates` enqueues a sweep job that a worker expands into per-operator link-estimate jobs, `POST /precompute/baseline` publishes the alias the three cache-only read routes probe, and `PUT /diff/shape/{epoch}` writes the record the changelog is served from. An epoch already swept but missing its alias publishes the alias alone from the same download.

**Budgets.** `maxDuration = 300`, and work stops at 270 s (`CRON_WORK_TIMEOUT_MS`) so the response is written before the platform limit. Historical repair gets 90 s of that, with a 40 s cap per attempt and at most three shape attempts per fire counting the current epoch. `scheduleDiffRepairs` in `lib/utils/diff-repair-schedule.ts` picks the current epoch first, then the newest gap, then rotates the remaining gaps by the six-hour slot so no gap starves. Deferred epochs are listed separately in the response.

**Idempotency.** Every write is safe to repeat. The sweep skips S3-cached contributors and attaches to in-flight duplicates. `POST /precompute/baseline` answers `already-cached` when the alias already names this input's hash, and aliases a cached result without solving. `PUT /diff/shape` answers `409` on an existing readable record.

**Errors.** `400` for an invalid `?epoch`; `404` when the snapshot does not exist upstream; `422` when the snapshot fails validation, names another epoch, or cannot build a canonical input; `504` when the work budget is exhausted; `502` for other upstream failures. Historical repair failures never change the status. Each failed phase is listed under `errors`, and no response body carries a raw upstream message or the internal service host.

**Manual backfill.** Pass `?epoch=N` with a valid bearer token.

**Relation to the read routes.** Until a fire publishes an epoch, `/api/shapley/baseline` answers `404 {status: "not-cached", epoch, tag}` and the widget hides. Nothing self-heals on a user request, because no reader computes. Sustained `baseline-not-cached` events for the latest epoch mean this cron or the worker is broken; check the cron logs and the service logs together.

---

## 2. Rust service deployment (any container platform)

The service ships as a single container image built from `services/shapley-rs/Dockerfile`. The same image runs both roles: `api` and `worker`.

### Deploy steps

1. Build the image and push it to a registry your platform can pull from:

   ```bash
   docker build -t <registry>/dz-shapley-service:<tag> services/shapley-rs
   docker push <registry>/dz-shapley-service:<tag>
   ```

2. Run the `api` process and one or more `worker` processes from that image. See Roles below.
3. Provision Redis and, optionally, an S3-compatible bucket. See Redis and the result cache below.
4. Set the environment variables from Section 4 on both the API and worker processes.
5. Expose only the API process to the network that reaches the frontend. The worker process needs no inbound access beyond its own `/health` listener.
6. Probe the API process:

   ```bash
   curl -fsS "https://<your-service-host>/health"
   ```

7. Connect the frontend. See Connecting the frontend below.

The image runs as a non-root user `shapley` in group `0`, with `chmod g=u` applied to `/app`. A container platform that assigns a random non-root UID at runtime can still execute the binary.

### Roles

The binary accepts a role argument (`api` or `worker`, also as `--role=api` / `--role=worker`):

```bash
# API process (HTTP server)
docker run --env-file .env -p 8080:8080 <registry>/dz-shapley-service:<tag> api

# Worker process (Redis stream consumer)
docker run --env-file .env <registry>/dz-shapley-service:<tag> worker
```

Run one or more API processes behind a load balancer and one or more worker processes consuming from the shared Redis stream. The job queue design and horizontal scaling rationale are documented in [adr/0001-async-compute-queue.md](adr/0001-async-compute-queue.md).

### Redis and the result cache

Provision a Redis instance with Streams support (Redis 5.0 or later). Set a password on it, and set the matching `REDIS_URL` (including that password) on both the API and worker processes. Job state is short-lived and TTL'd, so a Redis instance without RDB or AOF durability works fine.

An S3-compatible bucket is required in production. Set `S3_CACHE_BUCKET` to turn it on, `S3_CACHE_ENDPOINT` too when the bucket is not AWS S3 so the client switches to path-style addressing, and `AWS_REGION` plus the standard credential pair. The bucket holds three things the site depends on: solver results keyed by input hash, the epoch baseline aliases and sweep markers under `shapley/v3/publication/v1/` that every user-facing Shapley read probes, and the diff shapes under `diff/v1/` behind the changelog. Without it, every baseline read is `404 not-cached`, sweep status is always incomplete, `PUT /diff/shape` answers `503`, and nothing survives a restart.

Neither role reads the public snapshot bucket. The cron downloads each epoch's snapshot and pushes the derived input, alias, and diff shape to the service, so the processes need egress only to Redis and the object store. [ADR 0003](adr/0003-cron-side-snapshot-extraction.md) records why.

### REDIS_URL behavior

`REDIS_URL` is optional for the `api` role, but the cron needs it. Without it the `/jobs/*` and `/precompute*` endpoints return `503`, so no baseline or link estimate can be published (two different response bodies depending on the endpoint; see [Section 7](#7-operational-tooling)). Synchronous compute endpoints (`/shapley`, `/simulate`, `/link-estimate`) are unaffected.

For the `worker` role, `REDIS_URL` is required. The worker calls `worker::run`, which calls `.ok_or_else(|| anyhow!("worker role requires REDIS_URL"))` and exits immediately on startup if the store is absent.

### Auth posture (fail-closed)

`SHAPLEY_API_TOKEN` controls access to all compute endpoints. Resolution at startup, in `main.rs`:

- Token set: compute endpoints require `Authorization: Bearer <token>` (constant-time comparison).
- Token unset and `SHAPLEY_ALLOW_UNAUTHENTICATED=1`: compute endpoints are served unauthenticated. Local development only; a warning is logged.
- Token unset and `SHAPLEY_ALLOW_UNAUTHENTICATED` not set: compute endpoints are **not mounted at all**; only `/health` is served. This is the default for any internet-reachable deploy that forgets to set the token.

**Strongly recommended:** set `SHAPLEY_API_TOKEN` for any internet-reachable deployment. The service checks the bearer token against exactly one configured value; it does not support multiple valid tokens at once.

### Connecting the frontend

After deploying the service, set the frontend's `SHAPLEY_SERVICE_URL` to the service's base URL and `SHAPLEY_API_TOKEN` to the same token value configured on the service.

### Shutdown

Both roles handle SIGTERM through a graceful-shutdown signal (`main.rs`, `shutdown_signal`). In-flight work finishes within the platform's shutdown grace period or is redelivered by the stream.

### Secrets

Generate the compute bearer token and the Redis password once. Keep both out of git:

```bash
SHAPLEY_API_TOKEN=$(openssl rand -hex 32)
REDIS_PW=$(openssl rand -hex 24)
REDIS_URL="redis://:${REDIS_PW}@<your-redis-host>:6379"
```

Set these through your platform's secret store, not through files committed to the repository.

### Secret rotation

`SHAPLEY_API_TOKEN` holds exactly one value: `main.rs` compares the bearer token against a single configured string, not a list. Rotate it in this order:

1. Set the new token on the service and restart both the API and worker processes.
2. Set the same new token in the frontend's `SHAPLEY_API_TOKEN` and redeploy.

Between these two steps, the frontend sends the old token while the service expects the new one. Expect `401` responses from the frontend to the service during that window.

`CRON_SECRET` is read only by the two precompute cron routes (`lib/utils/cron-auth.ts`). Rotate it in Vercel and redeploy. Nothing else changes.

To rotate the Redis password, update `REDIS_URL` on both the API and worker processes together.

Generate any new secret the same way: `openssl rand -hex 32`.

---

## 3. Environment variables: frontend (Next.js)

Consumed by the Next.js server-side code. Set via `vercel env add <NAME> production` (or in `.env.local` for development). Source: `.env.example` and the consuming modules noted below. (`PYTHON_SHAPLEY_URL`, an alias for `SHAPLEY_SERVICE_URL`, is read by code and not listed in `.env.example`.)

### Required in production

| Variable | Default | Effect | Behavior when unset |
|---|---|---|---|
| `SHAPLEY_SERVICE_URL` | None | Base URL of the Rust Shapley microservice. Validated at module load (`lib/constants/config.ts`); must be `http://` or `https://`. Trailing slashes and known endpoint suffixes are stripped. | Every Shapley, link-value, and diff route answers `503`. There is no in-process solver. |
| `SHAPLEY_API_TOKEN` | None | Bearer token sent by the frontend to the Rust service (`lib/utils/shapley-remote.ts`). Never exposed to the browser. | Requests to the Rust service are sent without an `Authorization` header. If the service is configured fail-closed (no `SHAPLEY_ALLOW_UNAUTHENTICATED=1`), all compute calls return `401`. |
| `CRON_SECRET` | None | Secret Vercel injects into cron invocations as `Authorization: Bearer ${CRON_SECRET}`. Required for `/api/link-value/precompute`, checked with the constant-time helper in `lib/utils/cron-auth.ts`. | The cron route returns `503` on every fire, so no epoch is ever published and every Shapley read answers `404 not-cached`. |
| `SHAPLEY_INGEST_TOKEN` | None | Second token the cron sends as `X-Ingest-Token` when submitting a sweep, publishing a baseline, or writing a diff shape. Must equal the service's value. Never reaches the browser. | Those three writes fail locally with `503` and are reported per fire under `errors`; reads keep working. |
| `DZ_LEDGER_RPC_URL` | None | RPC endpoint for the DoubleZero ledger, a Solana sidechain. Required for any `/api/onchain/*` route (`lib/onchain/dz-rewards-record.ts`). No default in code: a previous default embedded a paid API key in source. | On-chain routes that need the DZ ledger fail. `ONCHAIN_ENABLED` gates whether they are attempted. |
| `NEXT_PUBLIC_SITE_URL` | None | Used by `app/layout.tsx` for `metadataBase` and OG image canonical URLs. | Falls back to a placeholder literal in `app/layout.tsx`. Set this to your production URL. |

### Optional

| Variable | Default | Effect | Behavior when unset |
|---|---|---|---|
| `PYTHON_SHAPLEY_URL` | None | Alias for `SHAPLEY_SERVICE_URL`. Checked in `lib/constants/config.ts` only when `SHAPLEY_SERVICE_URL` is unset. | Same as `SHAPLEY_SERVICE_URL` unset. |
| `DZ_IBRL_PRIORITY` | `20.0` | Objective weight of unicast demands in the canonical Shapley input (`CANONICAL_SHAPLEY_PARAMS`, `lib/constants/config.ts`). Part of the epoch tag fingerprint in `lib/utils/sweep-tag.ts`, so changing it makes every published alias and sweep marker miss until the cron republishes. | DoubleZero's current default. |
| `DZ_PUBLIC_LATENCY_MULTIPLIER` | `1.25` | Scale applied to public-internet link latency in the canonical input. Also part of the epoch tag fingerprint. | DoubleZero's current default. |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana mainnet RPC endpoint used by on-chain routes (`lib/onchain/program-ids.ts`). The public default is rate-limited; a dedicated provider is recommended for production. | Uses the public Solana mainnet RPC. |
| `DZ_REGISTRY_PROGRAM_ID` | `""` | DZ master registry program (Metro/Device/Link/Contributor accounts). Unset; the registry reader is unimplemented. The serviceability program id is known and hardcoded in `lib/onchain/contributor-directory.ts`. Setting this implicitly turns on `ONCHAIN_ENABLED` (`lib/onchain/program-ids.ts`). | On-chain routes return 503. |
| `DZ_REWARDS_PROGRAM_ID` | `""` | DZ revenue-distribution program on Solana mainnet. Known address: `dzrevZC94tBLwuHw1dyynZxaXTWyp7yocsinyEVPtt4`. | On-chain rewards routes are unavailable. |
| `ONCHAIN_ENABLED` | Unset (effectively disabled) | Master switch for `/api/onchain/*` routes. Derived in `lib/onchain/program-ids.ts` as `Boolean(DZ_REGISTRY_PROGRAM_ID) \|\| process.env.ONCHAIN_ENABLED === "1"`. Only the literal string `"1"` turns it on; setting `DZ_REGISTRY_PROGRAM_ID` turns it on implicitly. | On-chain routes return 503 with a stable error shape. |
| `DZ_ACCOUNT_HAS_DISCRIMINATOR` | `"1"` | Whether on-chain accounts carry an 8-byte Anchor discriminator prefix before the borsh payload (`lib/onchain/borsh-registry.ts`). Set to `"0"` for raw borsh structs. | Assumes the discriminator is present and strips 8 bytes before decode. |
| `DZ_IBRL_PRIORITY` | `20` | Priority weight for IBRL demand in the canonical Shapley input builder (`lib/constants/config.ts`, `CANONICAL_SHAPLEY_PARAMS.ibrlPriority`). | Falls back to a priority weight of `20` when unset, non-numeric, or negative. |
| `DZ_PUBLIC_LATENCY_MULTIPLIER` | `1.25` | Multiplier applied to public-link latency in the canonical Shapley input builder (`lib/constants/config.ts`, `CANONICAL_SHAPLEY_PARAMS.publicLatencyMultiplier`). | Falls back to a multiplier of `1.25` when unset, non-numeric, or negative. |

### Constants, not env

`DZ_RECORD_PROGRAM_ID` and `DZ_CONTRIBUTOR_REWARDS_PREFIX` are hardcoded constants in `lib/onchain/dz-rewards-record.ts`, not environment variables. The code never reads them from `process.env`. The rewards-accountant pubkey is hardcoded there too, as `REWARDS_ACCOUNTANT_MAINNET`. Older docs called it `DZ_REWARDS_ACCOUNTANT`, a name the code does not use.

| Constant | Value | Purpose |
|---|---|---|
| `DZ_RECORD_PROGRAM_ID` | `dzrecxigtaZQ3gPmt2X5mDkYigaruFR1rHCqztFTvx7` | DZ record program on the DZ ledger, holding contributor-rewards records. |
| `REWARDS_ACCOUNTANT_MAINNET` | `acCSLNUiAECGPGayZgBHHDuZW4hLkM7L6hxphXbogBR` | On-chain authority that writes contributor-rewards records. Also the base for `create_with_seed` derivation. |
| `DZ_CONTRIBUTOR_REWARDS_PREFIX` | `dz_contributor_rewards` | Seed prefix for deriving each epoch's reward record address. |

To target a fork or a test deployment, edit these constants directly. There is no environment-variable override.

---

## 4. Environment variables: shapley service

Consumed by `services/shapley-rs/src/main.rs`, `src/cache.rs`, `src/jobs.rs`, and `src/routes.rs`. `SHAPLEY_LP_TIME_LIMIT_SECS` is read inside the `network-shapley` engine crate this service depends on, not in this repository.

| Variable | Default | Effect | Behavior when unset |
|---|---|---|---|
| `PORT` | `8080` | TCP port for both `api` and `worker` health listener (`main.rs` `bind_port()`). | Binds to `0.0.0.0:8080`. |
| `RUST_LOG` | `info` (set in the Dockerfile) | Tracing filter for `tracing_subscriber::EnvFilter`. JSON-formatted output. | When the variable is entirely absent (e.g. running outside the container), the code falls back to `info,tower_http=debug` (`main.rs`). |
| `SHAPLEY_API_TOKEN` | — | Bearer token required on compute endpoints. Constant-time comparison in `main.rs` `require_auth`. | Compute endpoints are not served unless `SHAPLEY_ALLOW_UNAUTHENTICATED=1` is also set (fail-closed). |
| `SHAPLEY_ALLOW_UNAUTHENTICATED` | — | Set to `"1"` to serve compute endpoints without a token. Intended for local development only; a warning is logged at startup. | Compute endpoints require `SHAPLEY_API_TOKEN` (or are not mounted if neither is set). |
| `CORS_ORIGIN` | — | Restrict cross-origin requests to a single allowed origin (e.g. `https://your-app.example.com`). `main.rs` `build_cors()`. | No cross-origin requests are allowed (same-origin only). The frontend reaches the service server-side so CORS does not affect it. |
| `REDIS_URL` | — | Connection URL for the Redis job store (`jobs::store_from_env()`). Pool size 16, 5 s wait timeout. An empty string counts as unset. | `/jobs/*` and `/precompute*` endpoints return `503`. Worker role exits immediately on startup. |
| `S3_CACHE_BUCKET` | — | Bucket for solver results, the baseline and link-estimate aliases, the sweep markers, and the `diff/v1/` diff index (`cache::S3Cache::new()`, `diff_store.rs`). | Cache layer is a no-op. `GET /shapley/baseline` always answers `404 not-cached`, sweep status is always incomplete, and `PUT /diff/shape` and `GET /diff/missing` answer `503`. |
| `S3_CACHE_ENDPOINT` | — | Custom endpoint URL for an S3-compatible object store. When set, the client uses path-style addressing (`force_path_style = true`). | AWS S3 is used with virtual-host addressing (standard back-compat mode). |
| `AWS_REGION` | `us-east-1` | AWS region for the S3 client (`cache.rs`). | Defaults to `us-east-1`. |
| `AWS_ACCESS_KEY_ID` | — | S3 credentials via the standard AWS SDK credential chain. | SDK falls back to IAM role / instance metadata / env chain. Required when not running on AWS infrastructure with attached roles. |
| `AWS_SECRET_ACCESS_KEY` | — | Paired with `AWS_ACCESS_KEY_ID`. | See above. |
| `SHAPLEY_INGEST_TOKEN` | — | Second token, required on top of `SHAPLEY_API_TOKEN` for `POST /precompute/link-estimates`, `POST /precompute/baseline`, and `PUT /diff/shape/:epoch`, sent as `X-Ingest-Token`. Constant-time comparison in `main.rs` `require_ingest_auth`. An empty string counts as unset. | Those routes answer `503 {"error":"ingest not configured"}` and a warning is logged at startup. Reads keep working. Unlike the compute token, unset does not mean open. |
| `LINK_ESTIMATE_SOLVE_THREADS` | `4` | Worker count for the link-estimate solve's scoped thread pool (`routes.rs`). Each thread holds its own resident whole-demand solver model, so memory use grows with this value. | Uses `4` threads, clamped between `1` and the machine's available parallelism. |
| `SHAPLEY_LP_TIME_LIMIT_SECS` | `60` | Per-LP wall-clock time limit, in seconds, for the solver. Read inside the `network-shapley` engine crate. On timeout the coalition retries with a fresh model; if the retry also times out, the computation fails. | Uses a `60` second limit. |

---

## 5. CI

### `web.yml`: frontend CI

Triggers on push to `main` and on pull requests, with `paths-ignore: ["services/**", ".github/workflows/shapley-rs.yml"]`. Concurrency group `web-${{ github.ref }}` with `cancel-in-progress: true`.

| Step | Detail |
|---|---|
| Checkout | `actions/checkout` SHA-pinned (`11bd71901bbe5b1630ceea73d27597364c9af683`) |
| pnpm setup | `pnpm/action-setup` SHA-pinned (`a7487c7e89a18df4991f7f222e4898a00d66ddda`) |
| Node 20 | `actions/setup-node` SHA-pinned, `cache: pnpm` |
| Install | `pnpm install --frozen-lockfile` |
| Lint | `pnpm run lint` |
| Typecheck + regressions | `pnpm exec tsc --noEmit --incremental false`, then `test:diff-window`, `test:diff-repair-schedule`, `test:precompute-ingest`, `test:diff-shape-offline`, `test:baseline-probe`, `test:tracking-route`, `test:baseline-tag`, `test:sort-state` |
| Build | `pnpm run build` with `NODE_ENV=production`: prevents prerender from calling upstream sources during CI |

### `shapley-rs.yml`: Rust service CI

Triggers on push to `main` and on pull requests, path-filtered to `services/shapley-rs/**` and `.github/workflows/shapley-rs.yml`. Concurrency group `shapley-rs-${{ github.ref }}` with `cancel-in-progress: true`.

**`test` job:**

| Step | Detail |
|---|---|
| Checkout | `actions/checkout` SHA-pinned (`34e114876b0b11c390a56381ad16ebd13914f8d5`) |
| Toolchain | `dtolnay/rust-toolchain` SHA-pinned; toolchain `nightly-2026-05-26` with `rustfmt` + `clippy` components |
| Cargo cache | `actions/cache` SHA-pinned; keys on `Cargo.toml` hash; caches `~/.cargo/registry`, `~/.cargo/git`, and `services/shapley-rs/target` |
| fmt (advisory) | `cargo fmt --all -- --check` with `continue-on-error: true`: advisory until a local pre-commit hook is in place |
| clippy | `cargo clippy --locked --all-targets -- -D warnings`: hard fail on warnings |
| test | `cargo test --locked --release`, against a `redis:7.4.1` service container with `TEST_REDIS_URL=redis://127.0.0.1:6379/13`. `tests/alias_publication.rs` needs that empty database and refuses an occupied one |

**`docker` job** (requires `test`):

Builds the image via `docker/build-push-action` SHA-pinned (`10e90e3645eae34f1e60eeb005ba3a3d33f178e8`) with `push: false` and `cache-from/to: type=gha`. Tags the image `dz-shapley-service:ci`. This is a smoke test only. No image is pushed.

---

## 6. Rate limiting and security headers

### Rate limiting

Per-instance, in-memory rate limiting is implemented in `lib/utils/rate-limit.ts`. Presets at the bottom of that file:

| Preset | Limit | Window | Status |
|---|---|---|---|
| `RATE_LIMIT_HEAVY` | 10 req | 60 s | **Wired** to the three routes that start a solve: `shapley/simulate`, `shapley/jobs`, `link-value/jobs` |
| `RATE_LIMIT_STANDARD` | 60 req | 60 s | **Wired** to the cache-read proxies `shapley`, `shapley/baseline`, `shapley/tracking`, `diff`, `diff/contributor/[code]`, and to `validators/stake` |
| `RATE_LIMIT_LOOSE` | 120 req | 60 s | Defined for read-mostly cached endpoints; **not currently wired to any route** |

Limits are keyed by caller IP (`x-real-ip` preferred on Vercel; `x-forwarded-for` as fallback). Requests without resolvable IP headers proceed untracked by design. Rate-limiting is advisory. Because state is per-instance, the effective fleet-wide limit is `N × limit` where N is the number of Vercel replicas. For fleet-wide enforcement, replace the implementation with a shared Redis-backed limiter (the consumer API `checkRateLimit(req, opts)` does not change).

### Security headers

Applied to all routes via `next.config.ts`:

| Header | Value |
|---|---|
| `Content-Security-Policy` | Tight production policy: `default-src 'self'`; `script-src 'self' 'unsafe-inline'`; `style-src 'self' 'unsafe-inline'`; `connect-src 'self'`; `frame-ancestors 'none'`; `upgrade-insecure-requests`. Dev/preview builds add `https://vercel.live`, `https://*.pusher.com`, `wss://*.pusher.com`, and `'unsafe-eval'` to allow Vercel preview comments and hot-reload. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` (2 years, preload-eligible) |
| `X-Frame-Options` | `DENY` (belt-and-suspenders alongside CSP `frame-ancestors 'none'` for older browsers) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` |
| `X-Powered-By` | Suppressed (`poweredByHeader: false`) |

---

## 7. Operational tooling

### Health endpoint and status page

`GET /api/health` runs parallel probes against all upstreams (malbec topology/stats/status, DZ economic-hub, Shapley service `/health`, Solana RPC) with an 8 s timeout per probe. Responses include only `name`, `host` (hostname only, never full URLs or tokens), `status`, `latencyMs`, and a categorized `errorCode` when failing. Raw error text is discarded to avoid leaking internal addresses. The response is cached for 15 s (`Cache-Control: public, max-age=15, s-maxage=15, stale-while-revalidate=60`).

The `/status` page (`app/status/page.tsx`) shows the same data for operators. The `/api/health` cron (every 15 min, see `vercel.json`) keeps the function instance warm and doubles as an uptime ping.

### Queue admin script

`scripts/queue-clear.sh` operates on the `shapley:whatif:*` Redis keyspace. Requires `redis-cli` on `PATH`. Connection defaults to `127.0.0.1:6390` (dev compose); override with `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASS`.

Inspect the queue without changing anything:

```bash
redis-cli -u "$REDIS_URL" keys 'shapley:whatif:*'
```

**Modes:**

| Flag | Action | Notes |
|---|---|---|
| `--surgical` | Drops queued entries and the pending-entries list (PEL); recreates the consumer group in place | Stops the backlog without bouncing the worker. Keeps result cache, job state, and the dead-letter stream. |
| `--nuke` | Deletes every `shapley:whatif:*` key | Prompts for confirmation unless `--force` (or `--dry-run`) is passed. **Requires a worker restart** after (see Section 2 for restarting the worker process): the consumer group is gone until the worker's startup `ensure_group` recreates it. |

**Options:** `--cancel-running` first sets the cancel flag for every `state=running` job (stops in-flight sampling solves via the worker bridge); `--dry-run` prints what would happen without making changes; `--force` skips the `--nuke` confirmation.

```bash
# Stop the backlog without restarting the worker
scripts/queue-clear.sh --surgical

# Full wipe (requires confirmation + worker restart)
scripts/queue-clear.sh --nuke --cancel-running

# Connect to a remote Redis
REDIS_URL=redis://:<password>@redis.example.com:6379 scripts/queue-clear.sh --surgical
```

Without `REDIS_URL`, the async endpoints return one of two `503` bodies. `POST /jobs/simulate` and `POST /jobs/link-estimate` return `{ "error": "async jobs disabled (REDIS_URL not configured)" }`. `GET /jobs/{id}` and `DELETE /jobs/{id}` return `{ "error": "async jobs disabled" }`.

A corrupt cached object in S3 is treated as a cache miss and recomputed automatically. Deleting the object from the bucket forces the same recompute.

### Cache warming

The `/api/link-value/precompute` cron is the only cache-warming mechanism. No user request ever computes a baseline or a link estimate. After a new epoch appears, one fire downloads the snapshot, enqueues the sweep, publishes the baseline alias, and writes the diff shape. Once the marker, the alias, and the shape all exist, later fires return `already-swept` without a download. The response body reports each phase (`sweep`, `baseline`, `shape`, `repairs`, `errors`), so a failing phase is visible in the Vercel cron logs.

To warm one epoch by hand:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
  "https://dzcontributor.xyz/api/link-value/precompute?epoch=<N>"
```

Poll `GET {shapley-service}/jobs/{sweep_job_id}` for the sweep summary.

### Backfilling the diff index

The cron repairs the last 31 epochs, which is the window the changelog selector offers. Deeper history is a one-off from a workstation:

```bash
pnpm run backfill:diff -- --dry-run     # report what is missing
pnpm run backfill:diff                  # fill it, newest first
```

It needs `SHAPLEY_SERVICE_URL`, `SHAPLEY_API_TOKEN`, and `SHAPLEY_INGEST_TOKEN`. Each epoch is a ~110 MB download, so the full history takes a few hours. It is safe to interrupt and re-run: writes are create-only, so an epoch already stored answers `409` and counts as done. Run it after the first deploy and after any bump of the `DIFF_SHAPE_VERSION_PREFIX` constant in `src/diff_store.rs`.

### Backfilling baseline aliases

An epoch's alias exists only once the cron has fired for it, so after a first deploy the historical epochs have none. Publish them one at a time:

```bash
for e in $(seq 196 211); do
  curl -sS -H "Authorization: Bearer $CRON_SECRET" \
    "https://dzcontributor.xyz/api/link-value/precompute?epoch=$e"
done
```

Each fire downloads that epoch's snapshot once to build the input. An epoch whose result is already in the service's input-hash cache is aliased without a solve. Watch the `baseline-not-cached` events fall to zero for the latest epoch.

### Clearing a bad diff shape

A persisted shape is trusted for the life of the process. `DiffStore` keeps every shape it has read in memory with no TTL, so deleting `diff/v1/shape-{epoch:06}.json` from the bucket does not clear it from a running `api` process. To retire a shape, delete the object and restart the processes holding it. When every shape is suspect, bump `DIFF_SHAPE_VERSION_PREFIX` and refill.

### Object gateway acceptance test

The diff store depends on conditional writes (`If-None-Match: *` to create, `If-Match` to repair proven-corrupt bytes). Verify a new gateway supports them before deploying against it. Provision a disposable bucket named `pr24-canary-<UUID>`, set `TEST_S3_ENDPOINT` and `TEST_S3_BUCKET`, supply test credentials through the environment, and run from `services/shapley-rs`:

```bash
cargo test --locked --test diff_persistence gateway_conditional_contract -- --ignored --nocapture
```

The test refuses the production bucket and any pre-existing canary key. It checks concurrent create, the repair condition, and which bytes survive, then deletes its canary object on success. Record the gateway version and the result, then remove the bucket. A gateway that ignores or rejects these conditions blocks the write path; do not substitute unconditional retries.

### Alias publication rollout

Follow this order when the publication contract changes or the object gateway moves. Alias publication checks a stored authorization field, so roll workers before API processes: the new producer and the trusted readers must agree on the contract.

1. Verify the deployed API and worker images, and prepare the frontend ingest token.
2. Pause the cron, then roll every worker to the new image.
3. Roll the API processes, then deploy the frontend that sends both tokens. Resume the cron.
4. Warm the latest epoch through `/api/link-value/precompute`. Check the sweep summary and the child job results, and repeat until it reports `already-swept`.
5. Warm the agreed historical window, newest first with `?epoch=N`, one epoch at a time. Record any epoch that fails or does not finish so it can be resumed.
6. Inspect deeper gaps with `pnpm run backfill:diff -- --dry-run`, then run the bounded backfill.

Solver results keep their existing keys. Historical aliases are not migrated, so they need the explicit warm-up above. To roll back, keep alias publication disabled until a matching API and worker pair is available, preserve the stored results and metadata, and do not restore a reader that trusts aliases outside `shapley/v3/publication/v1/`.

