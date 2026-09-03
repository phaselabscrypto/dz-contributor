# Operations

Deployment and configuration reference for the DZ Contributor Rewards stack: a Next.js frontend deployed on Vercel, a Rust Shapley microservice run as a container, Redis for async job queuing, and an optional S3-compatible result cache.

For local development setup see [development.md](development.md). For service internals see [shapley-service.md](shapley-service.md).

---

## 1. Frontend (Vercel)

The reference deployment runs at `https://dzcontributor.xyz`, built by Vercel's GitHub integration from the `main` branch of `phaselabscrypto/dz-contributor`. Every push to `main` triggers a new deploy.

### First-time setup

1. Import the repository into Vercel as a new project.
2. Set every environment variable marked "Required in production" in Section 3.
3. Vercel reads the cron schedule from `vercel.json` and activates the three crons automatically. No extra configuration is needed.
4. Set your custom domain in the Vercel project settings.

### Cron jobs

Three cron schedules are defined in `vercel.json`:

| Path | Schedule | Purpose |
|------|----------|---------|
| `/api/health` | `*/15 * * * *` (every 15 min) | Keep the function instance warm; also used by the `/status` page |
| `/api/link-value/precompute` | `0 */6 * * *` (every 6 hours) | Cache-warming sweep for the latest epoch |
| `/api/shapley/precompute` | `30 */6 * * *` (every 6 hours, offset 30 min) | Warm the latest epoch's baseline so `/api/shapley/baseline` serves cache hits |

### Precompute cron (`/api/link-value/precompute`)

Implemented in `app/api/link-value/precompute/route.ts`. Key behaviors:

- **Auth:** Vercel sends `Authorization: Bearer ${CRON_SECRET}` on cron invocations when `CRON_SECRET` is set. The handler checks this with a constant-time comparison (`timingSafeEqual` from `node:crypto`; the equal-length pre-check it requires reveals only token length, never content). If `CRON_SECRET` is unset the route returns `503`; a header mismatch returns `401`. Manual backfill is possible by passing `?epoch=N` with a valid bearer token.
- **Idempotency:** Before fetching the snapshot, the handler checks the S3 "fully swept" marker via the Shapley service. If the marker is present, it returns `{ status: "already-swept" }` in under 2 s without touching the snapshot. Idempotent end-to-end: the sweep skips S3-cached contributors and attaches to in-flight duplicates.
- **What it enqueues:** If the marker is absent, the handler fetches the ~70 MB epoch snapshot, builds the canonical Shapley input (same key derivation as the UI flow so cache keys agree), enqueues one sweep job on the Rust service (`202 {job_id}`), and also enqueues a baseline precompute for the what-if simulator. Enqueued children run on the worker pool, not inside this function.
- **`maxDuration = 300`:** The snapshot fetch + parse measured 7–27 s locally. Vercel's default function duration would kill the cron mid-parse; 300 s gives headroom for the worst-case download while keeping the actual enqueue sub-second. See the comment in `app/api/link-value/precompute/route.ts`.
- **Error handling:** A `404` is returned when the epoch's snapshot does not exist upstream; other snapshot/upstream failures return `502`; a generic `500` covers everything else (raw error messages are not surfaced to avoid leaking the internal service host).

### Precompute cron (`/api/shapley/precompute`)

Implemented in `app/api/shapley/precompute/route.ts`. Warms the latest epoch's **baseline** (per-city Shapley) so `/api/shapley/baseline` and `/api/shapley?epoch=N` serve cache hits instead of triggering a cold synchronous solve inside a user request.

- **Auth:** same `CRON_SECRET` bearer check as the link-value cron (shared helper `lib/utils/cron-auth.ts`, constant-time compare). Unset secret → `503`; mismatch → `401`. Rate-limited per IP before the auth check. Manual backfill: `?epoch=N` with a valid bearer token.
- **What it enqueues:** builds the same canonical input the compute routes build, then `POST {service}/precompute`: the Rust service answers `200 {status: "already-cached"}` (input-hash hit) or `202 {status: "accepted", job_id}` and the solve runs on the worker pool. Idempotent per input hash. When the primary input came from the foundation CSVs, the cron ALSO warms the snapshot-built variant (`snapshotVariant` in the response): the two hash to different service cache keys, and the simulate/jobs routes (plus the foundation-fetch-failure fallback) build the snapshot variant.
- **Status codes:** `422` when the epoch's snapshot only supports the heuristic builder (no `city_weights`: cannot warm); `404` when the snapshot doesn't exist; a `JobStartError` from the service passes its upstream status through (e.g. the service's `503` = async jobs disabled); other failures → `502`. Outcomes are logged (`[shapley/precompute] epoch=… status=…`) so a stuck cron is visible in Vercel logs.
- **`maxDuration = 300`:** same rationale as the link-value cron (snapshot fetch + parse dominate; the enqueue is sub-second).
- **Relation to the baseline route's 202:** while the latest epoch is not yet warmed, `/api/shapley/baseline` responds `202 {status: "warming", …}`. The service finishes a router-cut synchronous solve in a detached task (the result still lands in memory + S3: `services/shapley-rs/src/routes.rs`, `shapley` handler), so warming self-heals on a later request; this cron remains the proactive warmer so user requests are cache hits in the first place. Sustained warming responses therefore mean both the cron AND self-heal are broken (or the service can't store at all). Check the Vercel cron logs and the service logs together.

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

An S3-compatible bucket for the result cache is optional. Set `S3_CACHE_BUCKET` to turn it on. Set `S3_CACHE_ENDPOINT` too when the bucket is not AWS S3: the client then switches to path-style addressing. Set `AWS_REGION` (default `us-east-1`) and supply credentials through the default AWS credential provider chain, for example `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

### REDIS_URL behavior

`REDIS_URL` is optional for the `api` role. Without it, `/jobs/*` endpoints return `503` (two different response bodies depending on the endpoint; see [Section 7](#7-operational-tooling)). Synchronous compute endpoints (`/shapley`, `/simulate`, `/link-estimate`) are unaffected.

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

Consumed by the Next.js server-side code. Set via `vercel env add <NAME> production` (or in `.env.local` for development). Source: `.env.example` and the consuming modules noted below. (`PYTHON_SHAPLEY_URL` is consumed by code but not listed in `.env.example`.)

### Required in production

| Variable | Default | Effect | Behavior when unset |
|---|---|---|---|
| `SHAPLEY_SERVICE_URL` | None | Base URL of the Rust Shapley microservice. Validated at module load (`lib/constants/config.ts`); must be `http://` or `https://`. Trailing slashes and known endpoint suffixes are stripped. | Falls back to the in-process TypeScript coalition-enumeration solver (directionally correct, not bit-comparable to Foundation output). Responses are labeled `local-ts-heuristic-DEV-ONLY`. |
| `SHAPLEY_API_TOKEN` | None | Bearer token sent by the frontend to the Rust service (`lib/utils/shapley-remote.ts`). Never exposed to the browser. | Requests to the Rust service are sent without an `Authorization` header. If the service is configured fail-closed (no `SHAPLEY_ALLOW_UNAUTHENTICATED=1`), all compute calls return `401`. |
| `CRON_SECRET` | None | Secret Vercel injects into cron invocations as `Authorization: Bearer ${CRON_SECRET}`. Required for both precompute crons (`/api/link-value/precompute`, `/api/shapley/precompute`); checked with the shared constant-time helper in `lib/utils/cron-auth.ts`. | Both precompute routes return `503 { "error": "CRON_SECRET not configured" }` on every invocation, disabling cache warming. The baseline route then answers `202 warming` until a manual backfill. |
| `DZ_LEDGER_RPC_URL` | None | RPC endpoint for the DoubleZero ledger, a Solana sidechain. Required for any `/api/onchain/*` route (`lib/onchain/dz-rewards-record.ts`). No default in code: a previous default embedded a paid API key in source. | On-chain routes that need the DZ ledger fail. `ONCHAIN_ENABLED` gates whether they are attempted. |
| `NEXT_PUBLIC_SITE_URL` | None | Used by `app/layout.tsx` for `metadataBase` and OG image canonical URLs. | Falls back to a placeholder literal in `app/layout.tsx`. Set this to your production URL. |

### Optional

| Variable | Default | Effect | Behavior when unset |
|---|---|---|---|
| `PYTHON_SHAPLEY_URL` | None | Legacy alias for `SHAPLEY_SERVICE_URL` (previous Python deployment). Checked in `lib/constants/config.ts` only when `SHAPLEY_SERVICE_URL` is unset. | Same as `SHAPLEY_SERVICE_URL` unset. |
| `DZ_CANONICAL_INPUTS_URL` | None | URL template (with `{N}` epoch placeholder) for Foundation-published canonical Shapley input CSVs (`lib/utils/canonical-inputs.ts`). | Falls back to S3 snapshot-derived inputs. |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana mainnet RPC endpoint used by on-chain routes (`lib/onchain/program-ids.ts`). The public default is rate-limited; a dedicated provider is recommended for production. | Uses the public Solana mainnet RPC. |
| `DZ_REGISTRY_PROGRAM_ID` | `""` | DZ master registry program (Metro/Device/Link/Contributor accounts). Pending DZ Foundation IDL. Setting this implicitly turns on `ONCHAIN_ENABLED` (`lib/onchain/program-ids.ts`). | On-chain routes return 503. |
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
| `REDIS_URL` | — | Connection URL for the Redis job store (`jobs::store_from_env()`). Pool size 16, 5 s wait timeout. | `/jobs/*` endpoints return `503`. Worker role exits immediately on startup. |
| `S3_CACHE_BUCKET` | — | Bucket name for the S3-compatible result cache (`cache::S3Cache::new()`). | Cache layer is a no-op; results are not persisted across restarts. |
| `S3_CACHE_ENDPOINT` | — | Custom endpoint URL for an S3-compatible object store. When set, the client uses path-style addressing (`force_path_style = true`). | AWS S3 is used with virtual-host addressing (standard back-compat mode). |
| `AWS_REGION` | `us-east-1` | AWS region for the S3 client (`cache.rs`). | Defaults to `us-east-1`. |
| `AWS_ACCESS_KEY_ID` | — | S3 credentials via the standard AWS SDK credential chain. | SDK falls back to IAM role / instance metadata / env chain. Required when not running on AWS infrastructure with attached roles. |
| `AWS_SECRET_ACCESS_KEY` | — | Paired with `AWS_ACCESS_KEY_ID`. | See above. |
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
| clippy | `cargo clippy --all-targets -- -D warnings`: hard fail on warnings |
| test | `cargo test --release` |

**`docker` job** (requires `test`):

Builds the image via `docker/build-push-action` SHA-pinned (`10e90e3645eae34f1e60eeb005ba3a3d33f178e8`) with `push: false` and `cache-from/to: type=gha`. Tags the image `dz-shapley-service:ci`. This is a smoke test only. No image is pushed.

---

## 6. Rate limiting and security headers

### Rate limiting

Per-instance, in-memory rate limiting is implemented in `lib/utils/rate-limit.ts`. Presets at the bottom of that file:

| Preset | Limit | Window | Status |
|---|---|---|---|
| `RATE_LIMIT_HEAVY` | 10 req | 60 s | **Wired** to nine compute/diff routes: `shapley`, `shapley/precompute`, `shapley/simulate`, `shapley/baseline`, `shapley/tracking`, `shapley/jobs`, `link-value/jobs`, `diff`, `diff/contributor/[code]` |
| `RATE_LIMIT_STANDARD` | 60 req | 60 s | **Wired** to `validators/stake`. Defined for routes that do non-trivial work but aren't CPU-bound. |
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

The `/api/link-value/precompute` cron (every 6 hours) is the primary cache-warming mechanism. After each new epoch appears, the sweep enqueues per-contributor link-estimate jobs; once all are S3-cached, steady-state cron fires complete in under 2 s via the "fully swept" marker fast-path. To trigger a manual backfill for a specific epoch:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
  "https://dzcontributor.xyz/api/link-value/precompute?epoch=<N>"
```

Poll `GET {shapley-service}/jobs/{sweep_job_id}` for the sweep summary.

The `/api/shapley/precompute` cron (30 minutes offset) warms the baseline the same way; its manual backfill is:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
  "https://dzcontributor.xyz/api/shapley/precompute?epoch=<N>"
```
