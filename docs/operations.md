# Operations

Deployment and configuration reference for the DZ Contributor Rewards stack: a Next.js frontend deployed on Vercel, a Rust Shapley microservice run as a container, Redis for async job queuing, and an optional S3-compatible result cache.

For local development setup see [development.md](development.md). For service internals see [shapley-service.md](shapley-service.md).

---

## 1. Frontend (Vercel)

The frontend auto-deploys on every push to `main` via Vercel's GitHub integration. No additional deploy configuration is needed beyond setting environment variables (see [Section 3](#3-environment-variables--frontend-nextjs)).

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
- **What it enqueues:** If the marker is absent, the handler fetches the ~70 MB epoch snapshot, builds the canonical Shapley input (same key derivation as the UI flow so cache keys align), enqueues one sweep job on the Rust service (`202 {job_id}`), and also enqueues a baseline precompute for the what-if simulator. Enqueued children run on the worker pool, not inside this function.
- **`maxDuration = 300`:** The snapshot fetch + parse measured 7–27 s locally. Vercel's default function duration would kill the cron mid-parse; 300 s gives headroom for the worst-case download while keeping the actual enqueue sub-second. See the comment in `app/api/link-value/precompute/route.ts`.
- **Error handling:** A `404` is returned when the epoch's snapshot does not exist upstream; other snapshot/upstream failures return `502`; a generic `500` covers everything else (raw error messages are not surfaced to avoid leaking the internal service host).

### Precompute cron (`/api/shapley/precompute`)

Implemented in `app/api/shapley/precompute/route.ts`. Warms the latest epoch's **baseline** (per-city Shapley) so `/api/shapley/baseline` and `/api/shapley?epoch=N` serve cache hits instead of triggering a cold synchronous solve inside a user request.

- **Auth:** same `CRON_SECRET` bearer check as the link-value cron (shared helper `lib/utils/cron-auth.ts`, constant-time compare). Unset secret → `503`; mismatch → `401`. Rate-limited per IP before the auth check. Manual backfill: `?epoch=N` with a valid bearer token.
- **What it enqueues:** builds the same canonical input the compute routes build, then `POST {service}/precompute` — the Rust service answers `200 {status: "already-cached"}` (input-hash hit) or `202 {status: "accepted", job_id}` and the solve runs on the worker pool. Idempotent per input hash. When the primary input came from the foundation CSVs, the cron ALSO warms the snapshot-built variant (`snapshotVariant` in the response): the two hash to different service cache keys, and the simulate/jobs routes (plus the foundation-fetch-failure fallback) build the snapshot variant.
- **Status codes:** `422` when the epoch's snapshot only supports the heuristic builder (no `city_weights` — cannot warm); `404` when the snapshot doesn't exist; a `JobStartError` from the service passes its upstream status through (e.g. the service's `503` = async jobs disabled); other failures → `502`. Outcomes are logged (`[shapley/precompute] epoch=… status=…`) so a stuck cron is visible in Vercel logs.
- **`maxDuration = 300`:** same rationale as the link-value cron (snapshot fetch + parse dominate; the enqueue is sub-second).
- **Relation to the baseline route's 202:** while the latest epoch is not yet warmed, `/api/shapley/baseline` responds `202 {status: "warming", …}`. The service finishes a router-cut synchronous solve in a detached task (the result still lands in memory + S3 — `services/shapley-rs/src/routes.rs`, `shapley` handler), so warming self-heals on a later request; this cron remains the proactive warmer so user requests are cache hits in the first place. Sustained warming responses therefore mean both the cron AND self-heal are broken (or the service can't store at all) — check the Vercel cron logs and the service logs together.

---

## 2. Rust service deployment (platform-generic)

Build the image from `services/shapley-rs/Dockerfile`. The Dockerfile produces an OpenShift-compatible image: the runtime user is `shapley` with group `0` (`gid=0`) and `g=u` permissions so a random non-root UID injected by the container platform can still execute the binary.

### Roles

The binary accepts a role argument (`api` or `worker`, also as `--role=api` / `--role=worker`):

```bash
# API pod (HTTP server)
docker run --env-file .env -p 8080:8080 dz-shapley-service api

# Worker pod (Redis stream consumer)
docker run --env-file .env dz-shapley-service worker
```

Run one or more `api` replicas behind a load balancer and one or more `worker` replicas consuming from the shared Redis stream. The job queue design and horizontal scaling rationale are documented in [adr/0001-async-compute-queue.md](adr/0001-async-compute-queue.md).

### REDIS_URL

`REDIS_URL` is optional for the `api` role. Without it, `/jobs/*` endpoints return `503 { "error": "async jobs disabled" }`. Synchronous compute endpoints (`/shapley`, `/simulate`, `/link-estimate`) are unaffected.

For the `worker` role `REDIS_URL` is required: the worker calls `worker::run` which calls `.ok_or_else(|| anyhow!("worker role requires REDIS_URL"))` and exits immediately on startup if the store is absent.

### Auth posture (fail-closed)

`SHAPLEY_API_TOKEN` controls access to all compute endpoints. Resolution at startup (in `main.rs`):

- Token set → compute endpoints require `Authorization: Bearer <token>` (constant-time comparison).
- Token unset + `SHAPLEY_ALLOW_UNAUTHENTICATED=1` → compute endpoints served unauthenticated (dev only; a warning is logged).
- Token unset + `SHAPLEY_ALLOW_UNAUTHENTICATED` not set → compute endpoints are **not mounted at all**; only `/health` is served. This is the default for any internet-reachable deploy that forgets to set the token.

**Strongly recommended:** set `SHAPLEY_API_TOKEN` for any internet-reachable deployment.

### S3-compatible result cache

Set `S3_CACHE_BUCKET` to enable. When `S3_CACHE_ENDPOINT` is also set, the client uses that URL with path-style addressing (virtual-host `<bucket>.<host>` is not used). Credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` via the standard AWS SDK credential chain.

### Connecting the frontend

After deploying the service, set the frontend's `SHAPLEY_SERVICE_URL` to the service base URL and `SHAPLEY_API_TOKEN` to the matching token.

---

## 3. Environment variables — frontend (Next.js)

Consumed by the Next.js server-side code. Set via `vercel env add <NAME> production` (or in `.env.local` for development). Source: `.env.example` and the consuming modules noted below. (`SHAPLEY_API_TOKEN`, `PYTHON_SHAPLEY_URL`, and `CRON_SECRET` are consumed by code but not listed in `.env.example`.)

| Variable | Default | Effect | Behavior when unset |
|---|---|---|---|
| `SHAPLEY_SERVICE_URL` | — | Base URL of the Rust Shapley microservice. Validated at module load (`lib/constants/config.ts`); must be `http://` or `https://`. Trailing slashes and known endpoint suffixes are stripped. | Falls back to the in-process TypeScript coalition-enumeration solver (directionally correct, not bit-comparable to Foundation output). Responses are labeled `local-ts-heuristic-DEV-ONLY`. |
| `PYTHON_SHAPLEY_URL` | — | Legacy alias for `SHAPLEY_SERVICE_URL` (previous Python deployment). Checked in `lib/constants/config.ts` only when `SHAPLEY_SERVICE_URL` is unset. | Same as `SHAPLEY_SERVICE_URL` unset. |
| `SHAPLEY_API_TOKEN` | — | Bearer token sent by the frontend to the Rust service (`lib/utils/shapley-remote.ts`). Never exposed to the browser. | Requests to the Rust service are sent without an `Authorization` header. If the service is configured fail-closed (no `SHAPLEY_ALLOW_UNAUTHENTICATED=1`), all compute calls return `401`. |
| `DZ_CANONICAL_INPUTS_URL` | — | URL template (with `{N}` epoch placeholder) for Foundation-published canonical Shapley input CSVs. Described in `.env.example`. | Falls back to S3 snapshot-derived inputs. |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana mainnet RPC endpoint used by on-chain routes (`lib/onchain/program-ids.ts`). The public default is rate-limited; a dedicated provider (e.g. Helius) is recommended for production. | Uses the public Solana mainnet RPC. |
| `DZ_LEDGER_RPC_URL` | — | RPC endpoint for the DoubleZero ledger (a Solana sidechain). Required for any `/api/onchain/*` route. No default in code — a previous default embedded a paid API key in source. | On-chain routes that need the DZ ledger will fail; `ONCHAIN_ENABLED` gates whether they are attempted. |
| `DZ_REGISTRY_PROGRAM_ID` | `""` | DZ master registry program (Metro/Device/Link/Contributor accounts). Pending DZ Foundation IDL. Setting this implicitly enables `ONCHAIN_ENABLED` (`lib/onchain/program-ids.ts`). | On-chain routes return 503. |
| `DZ_REWARDS_PROGRAM_ID` | `""` | DZ revenue-distribution program on Solana mainnet. Known address: `dzrevZC94tBLwuHw1dyynZxaXTWyp7yocsinyEVPtt4`. | On-chain rewards routes are unavailable. |
| `DZ_RECORD_PROGRAM_ID` | `dzrecxigtaZQ3gPmt2X5mDkYigaruFR1rHCqztFTvx7` | DZ record program on the DZ ledger (contributor-rewards records). Default is hardcoded in `lib/onchain/dz-rewards-record.ts`. Override only if targeting a fork or test deployment. | Uses the hardcoded production default. |
| `DZ_REWARDS_ACCOUNTANT` | `acCSLNUiAECGPGayZgBHHDuZW4hLkM7L6hxphXbogBR` | On-chain authority that writes contributor-rewards records; also the base for `create_with_seed` derivation. Default hardcoded in the record module. | Uses the hardcoded production default. |
| `DZ_CONTRIBUTOR_REWARDS_PREFIX` | `dz_contributor_rewards` | Seed prefix for deriving each epoch's reward record address. Confirmed by DZ Foundation 2026-05-14. Default hardcoded in the record module. | Uses the hardcoded default. |
| `ONCHAIN_ENABLED` | unset (effectively disabled) | Master switch for `/api/onchain/*` routes. Derived in `lib/onchain/program-ids.ts` as `Boolean(DZ_REGISTRY_PROGRAM_ID) \|\| process.env.ONCHAIN_ENABLED === "1"` — only the literal string `"1"` enables it; setting `DZ_REGISTRY_PROGRAM_ID` enables it implicitly. | On-chain routes return 503 with a stable error shape. |
| `DZ_ACCOUNT_HAS_DISCRIMINATOR` | `"1"` | Whether on-chain accounts carry an 8-byte Anchor discriminator prefix before the borsh payload. Set to `"0"` for raw borsh structs. | Assumes discriminator present (strip 8 bytes before decode). |
| `CRON_SECRET` | — | Secret Vercel injects into cron invocations as `Authorization: Bearer ${CRON_SECRET}`. Required for BOTH precompute crons (`/api/link-value/precompute`, `/api/shapley/precompute`); checked with the shared constant-time helper in `lib/utils/cron-auth.ts`. | Both precompute routes return `503 { "error": "CRON_SECRET not configured" }` on every invocation, disabling cache warming — the baseline route then answers `202 warming` until a manual backfill. |
| `NEXT_PUBLIC_SITE_URL` | `https://dz-contributor.vercel.app` | Used by `app/layout.tsx` for `metadataBase` and OG image canonical URLs. | Falls back to the Vercel project default URL. |
| `NEXT_PUBLIC_SENTRY_DSN` | — | Sentry DSN for error tracking. The SDK calls in `lib/observability.ts` are no-ops until activated. | Errors log to console in dev; swallowed in production. |

---

## 4. Environment variables — shapley service

Consumed by `services/shapley-rs/src/main.rs`, `src/cache.rs`, and `src/jobs.rs`.

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

---

## 5. CI

### `web.yml` — frontend CI

Triggers on push to `main` and on pull requests, with `paths-ignore: ["services/**", ".github/workflows/shapley-rs.yml"]`. Concurrency group `web-${{ github.ref }}` with `cancel-in-progress: true`.

| Step | Detail |
|---|---|
| Checkout | `actions/checkout` SHA-pinned (`11bd71901bbe5b1630ceea73d27597364c9af683`) |
| pnpm setup | `pnpm/action-setup` SHA-pinned (`a7487c7e89a18df4991f7f222e4898a00d66ddda`) |
| Node 20 | `actions/setup-node` SHA-pinned, `cache: pnpm` |
| Install | `pnpm install --frozen-lockfile` |
| Lint | `pnpm run lint` |
| Build | `pnpm run build` with `NODE_ENV=production` — prevents prerender from calling upstream sources during CI |

### `shapley-rs.yml` — Rust service CI

Triggers on push to `main` and on pull requests, path-filtered to `services/shapley-rs/**` and `.github/workflows/shapley-rs.yml`. Concurrency group `shapley-rs-${{ github.ref }}` with `cancel-in-progress: true`.

**`test` job:**

| Step | Detail |
|---|---|
| Checkout | `actions/checkout` SHA-pinned (`34e114876b0b11c390a56381ad16ebd13914f8d5`) |
| Toolchain | `dtolnay/rust-toolchain` SHA-pinned; toolchain `nightly-2026-05-26` with `rustfmt` + `clippy` components |
| Cargo cache | `actions/cache` SHA-pinned; keys on `Cargo.toml` hash; caches `~/.cargo/registry`, `~/.cargo/git`, and `services/shapley-rs/target` |
| fmt (advisory) | `cargo fmt --all -- --check` with `continue-on-error: true` — advisory until a local pre-commit hook is in place |
| clippy | `cargo clippy --all-targets -- -D warnings` — hard fail on warnings |
| test | `cargo test --release` |

**`docker` job** (requires `test`):

Builds the image via `docker/build-push-action` SHA-pinned (`10e90e3645eae34f1e60eeb005ba3a3d33f178e8`) with `push: false` and `cache-from/to: type=gha`. Tags the image `dz-shapley-service:ci`. This is a smoke test only — no image is pushed.

---

## 6. Rate limiting and security headers

### Rate limiting

Per-instance, in-memory rate limiting is implemented in `lib/utils/rate-limit.ts`. Presets at the bottom of that file:

| Preset | Limit | Window | Status |
|---|---|---|---|
| `RATE_LIMIT_HEAVY` | 10 req | 60 s | **Wired** to the eight compute/diff routes (`shapley`, `shapley/simulate`, `shapley/baseline`, `shapley/tracking`, `shapley/jobs`, `link-value/jobs`, `diff`, `diff/contributor/[code]`) |
| `RATE_LIMIT_STANDARD` | 60 req | 60 s | Defined for routes that do non-trivial work but aren't CPU-bound; **not currently wired to any route** |
| `RATE_LIMIT_LOOSE` | 120 req | 60 s | Defined for read-mostly cached endpoints; **not currently wired to any route** |

Limits are keyed by caller IP (`x-real-ip` preferred on Vercel; `x-forwarded-for` as fallback). Requests without resolvable IP headers proceed untracked by design — rate-limiting is advisory. Because state is per-instance, the effective fleet-wide limit is `N × limit` where N is the number of Vercel replicas. For fleet-wide enforcement, replace the implementation with a shared Redis-backed limiter (the consumer API `checkRateLimit(req, opts)` does not change).

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

`GET /api/health` runs parallel probes against all upstreams (malbec topology/stats/status, DZ economic-hub, Shapley service `/health`, Solana RPC) with an 8 s timeout per probe. Responses include only `name`, `host` (hostname only — never full URLs or tokens), `status`, `latencyMs`, and a categorized `errorCode` when failing. Raw error text is discarded to avoid leaking internal addresses. The response is cached for 15 s (`Cache-Control: public, max-age=15, s-maxage=15, stale-while-revalidate=60`).

The `/status` page (`app/status/page.tsx`) surfaces the same data for operators. The `/api/health` cron (every 15 min, see `vercel.json`) keeps the function instance warm and doubles as an uptime ping.

### Queue admin script

`scripts/queue-clear.sh` operates on the `shapley:whatif:*` Redis keyspace. Requires `redis-cli` on `PATH`. Connection defaults to `127.0.0.1:6390` (dev compose); override with `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASS`.

**Modes:**

| Flag | Action | Notes |
|---|---|---|
| `--surgical` | Drops queued entries and the pending-entries list (PEL); recreates the consumer group in place | Stops the backlog without bouncing the worker. Keeps result cache, job state, and the dead-letter stream. |
| `--nuke` | Deletes every `shapley:whatif:*` key | Prompts for confirmation unless `--force` (or `--dry-run`) is passed. **Requires a worker restart** after — the consumer group is gone until the worker's startup `ensure_group` recreates it. |

**Options:** `--cancel-running` first sets the cancel flag for every `state=running` job (stops in-flight sampling solves via the worker bridge); `--dry-run` prints what would happen without making changes; `--force` skips the `--nuke` confirmation.

```bash
# Stop the backlog without restarting the worker
scripts/queue-clear.sh --surgical

# Full wipe (requires confirmation + worker restart)
scripts/queue-clear.sh --nuke --cancel-running

# Connect to a remote Redis
REDIS_URL=redis://:<password>@redis.example.com:6379 scripts/queue-clear.sh --surgical
```

### Cache warming

The `/api/link-value/precompute` cron (every 6 hours) is the primary cache-warming mechanism. After each new epoch appears, the sweep enqueues per-contributor link-estimate jobs; once all are S3-cached, steady-state cron fires complete in under 2 s via the "fully swept" marker fast-path. To trigger a manual backfill for a specific epoch:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
  "https://your-deploy.vercel.app/api/link-value/precompute?epoch=<N>"
```

Poll `GET {shapley-service}/jobs/{sweep_job_id}` for the sweep summary.

The `/api/shapley/precompute` cron (30 minutes offset) warms the baseline the same way; its manual backfill is:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
  "https://your-deploy.vercel.app/api/shapley/precompute?epoch=<N>"
```
