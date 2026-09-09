# dz-shapley-service

Rust HTTP wrapper around the
[`network-shapley-rs`](https://github.com/doublezerofoundation/network-shapley-rs)
crate, built against Phase's rev-pinned fork
[`phaselabscrypto/network-shapley-rs`](https://github.com/phaselabscrypto/network-shapley-rs)
(see `Cargo.toml`). Built so the Next.js frontend can call a single endpoint and
get LP-correct Shapley values without bundling a Rust solver client-side. The
full reference is [`docs/shapley-service.md`](../../docs/shapley-service.md).

## Endpoints

Every route except `/health` requires `Authorization: Bearer $SHAPLEY_API_TOKEN`
when the token is set; the ones marked *ingest* also require
`X-Ingest-Token: $SHAPLEY_INGEST_TOKEN`.

```
GET  /health           -> { status, service, version }

# sync compute
POST /shapley          -> ShapleyResponse        { method, operator_count, values }   (single-flighted per input hash)
POST /simulate         -> SimulateResponse       { baseline, modified, stats }        (what-if in one shot; reuses untouched cities)
POST /link-estimate    -> LinkEstimateResponse   (faithful retag-Shapley; sync; S3-served when precomputed; 422 above 12 focus links)

# cache-only read (the only surface a page load reaches)
GET  /shapley/baseline?tag= -> BaselineAlias     (published baseline for an epoch tag; 404 {status:"not-cached"}; never computes)

# async jobs (Redis)
POST /jobs/simulate         -> 202 { job_id }    (done at submit on an S3 hit)
POST /jobs/link-estimate    -> 202 { job_id }    (in-flight dedup; done at submit on an S3 hit; 422 above 19 focus links)
POST /jobs/link-estimate/by-tag -> 202 { job_id } | 404   ({tag, operator_focus}: completes from the published alias, no input needed)
GET  /jobs/:id              -> { state, progress | result | error }
DELETE /jobs/:id            -> 202 { state: "cancelling" }

# publication (driven by the Next.js cron)
POST /precompute            -> 200 already-cached | 202 { job_id, input_hash }        (baseline warm by input hash)
POST /precompute/baseline   -> 200 already-cached | 202 { job_id, input_hash, tag }   (ingest; publishes the epoch alias)
POST /precompute/link-estimates -> 202 { job_id }                                      (ingest; one sweep job, fans out per operator)
GET  /precompute/link-estimates/status?tag= -> { complete, tag }                       (is the sweep marker present)

# diff index
GET  /diff?from&to     -> NetworkDiffResponse      (topology diff between two epochs; x-diff-degraded: 1 when an intermediate was skipped)
GET  /diff/contributor/:code?from&to -> ContributorDiffResponse (per-contributor diff; no display name)
PUT  /diff/shape/:epoch -> 201 created | 409 readable existing record                  (ingest; DiffShape extracted by the cron)
GET  /diff/missing?latest=N&depth=D -> { missing }                                      (depth default 31, max 200)
```

Request bodies are capped at 2 MB and every request at 120 s.

### Epoch precompute sweep

Epoch inputs are immutable, so each `(epoch, operator)` link-estimate is
computed once and persisted to S3 (`shapley/v3/link-estimate-{payload_hash}.bin`,
keyed by the job payload hash). The Vercel cron `GET /api/link-value/precompute`
(authed via `CRON_SECRET`) builds the epoch input and calls the sweep, which
enqueues one sweep job. A worker expands it into per-operator jobs:

```bash
curl -fsS -X POST "$BASE/precompute/link-estimates" \
  -H "authorization: Bearer $SHAPLEY_API_TOKEN" \
  -H "X-Ingest-Token: $SHAPLEY_INGEST_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary @sweep.json
```

The body contains `input` and `tag`. Omit `operators` to derive the complete set. Poll the returned `job_id` for the sweep summary: `enqueued`, `cached`, `skipped` (operators above 19 focus links), `already_running`, `failed`, and `marker_written`. Only an ingest-authorized sweep with the derived operator set publishes per-operator aliases and the completion marker; an explicit `operators` subset warms the cache but never writes a marker.

Result keys remain under `shapley/v3/`; trusted aliases and markers use `shapley/v3/publication/v1/`. Publication awaits result and alias writes, while the claim heartbeat remains active. A failed alias leaves the marker absent so a later sweep can retry from cached results.

### Baseline aliases

The hash-keyed `shapley/v3/cache-{hash}.bin` object is not addressable without
the full input, and building that input means downloading the epoch snapshot.
`POST /precompute/baseline` therefore takes a `tag` (the Next.js `baselineTag`);
when the result lands, the worker writes
`shapley/v3/publication/v1/baseline-alias-{hash(tag)}.json`, which carries the
full `ShapleyResponse` plus `tag` and `input_hash`. The alias is
written after the result object, so it never points at nothing. The route
answers `200 already-cached` only when an alias for the tag names this input's
hash; a cached result with no alias enqueues, and the worker aliases it
without solving. `GET /shapley/baseline?tag=` reads that one object and answers
`404 {status:"not-cached"}` on a miss. It is the only route user-facing
requests reach, so a browser can never start a solve.

The same alias pattern serves link values: the sweep writes
`shapley/v3/publication/v1/link-estimate-alias-{hash(tag + "\0" + focus)}.json`
per operator, and `POST /jobs/link-estimate/by-tag` completes a job from it, so
the frontend can answer `/link-value` without downloading a snapshot to name the
result. A miss is a plain `404`; the caller then falls back to a real
`/jobs/link-estimate` submit.

Concurrent cold `POST /shapley` requests for one input hash share a single
solve inside a process (`src/inflight.rs`); later callers await the first.

Wire-types live in `src/model.rs` and mirror the JSON our Next.js routes
already produce (see `lib/types/shapley.ts`).

### Input limits

Both `/shapley` and `/link-estimate` enforce dimension limits before
running the LP solver to prevent pathological inputs:

| Field | Max |
|-------|-----|
| `devices` | 500 |
| `private_links` | 2,000 |
| `public_links` | 2,000 |
| `demands` | 2,000 |
| distinct operators (Shapley players) | 20 |
| focus links, sync `/link-estimate` | 12 (422 above; use `/jobs/link-estimate`) |
| focus links, async / sweep | 19 (players = links + "Others" = 20) |

Request body limit: **2 MB**. Request timeout: **120 s**. Link-estimate solves
run on a scoped rayon pool of `LINK_ESTIMATE_SOLVE_THREADS` threads (default
4); each rayon worker holds a resident HiGHS model, so the global default of 16
exhausted a 16 GiB worker pod.

## Local development

```bash
SHAPLEY_ALLOW_UNAUTHENTICATED=1 cargo run --release
# in another shell
./tests/smoke.sh
```

Auth is fail-closed: without `SHAPLEY_API_TOKEN` or the dev opt-in
`SHAPLEY_ALLOW_UNAUTHENTICATED=1`, only `/health` is mounted and every other
step of the smoke script fails. With a token set, export `SHAPLEY_API_TOKEN`
before running `smoke.sh`.

`smoke.sh` runs nine steps against a live instance: `/health`; `/shapley` on
`tests/fixtures/simple.json` within 1% of the upstream README values;
`/link-estimate` (method `retag-shapley-rs`); the three-operator structural
check; a `/health` latency budget; `/diff?from=204&to=211` and
`/diff/contributor/tsw` (these need the epoch 204–211 shapes in the bucket, see
`tests/fixtures/diff/shapes/`); and the `/shapley/baseline` miss contract. Step
8 calls `POST /diff/precompute`, which the service does not serve, so that step
fails.

### Local async testing (`/jobs/*`)

The async path needs Redis plus **both** roles. The `api` role enqueues onto a
Redis Stream and a `worker` role drains it. Run only `api` and jobs sit at
`running` forever (nothing consumes the stream).

`docker-compose.yml` brings up Redis and MinIO (the service stays on the host so
`cargo` resolves the `network-shapley` path dep and rebuilds incrementally):

```bash
docker compose up -d                                          # Redis on :6390, MinIO on :9000
PORT=8099 REDIS_URL=redis://:devpass@127.0.0.1:6390 cargo run -- api      # shell 1
PORT=8098 REDIS_URL=redis://:devpass@127.0.0.1:6390 cargo run -- worker   # shell 2
```

Then drive the lifecycle (`sim.json` = `{ "baseline": {...}, "modified": {...} }`,
both `ShapleyInputIn`):

```bash
JOB=$(curl -fsS -X POST localhost:8099/jobs/simulate \
  -H 'content-type: application/json' --data @sim.json \
  | sed -n 's/.*"job_id":"\([^"]*\)".*/\1/p')
curl -fsS localhost:8099/jobs/$JOB            # poll: running (progress %) → done (result)
curl -fsS -X DELETE localhost:8099/jobs/$JOB  # cancel: cooperative, takes effect at the next city / coalition boundary
```

Inspect the queue with `redis-cli -p 6390 -a devpass keys 'shapley:whatif:*'`;
tear down with `docker compose down`. To test the compute alone (no Redis or queue),
hit the synchronous `POST /simulate` on the `api` process instead.

> **Pitfall:** `redis-cli flushall` deletes the Stream **consumer group**, and
> the worker only creates it at startup. After a flush it spins on
> `xreadgroup failed; backing off` until restarted. Prefer
> `scripts/queue-clear.sh --surgical` (recreates the group in place), or
> restart the worker after a flush.

### Local S3 testing (durable result cache)

The S3 layer (baseline cache and epoch aliases, link-estimate results and
aliases, sweep markers, simulate results (the persistence behind shareable
forecast URLs), and the `diff/v1/` shape index) targets any S3-compatible
endpoint via `S3_CACHE_ENDPOINT` (path-style), so MinIO models production
faithfully. Without it every `GET /shapley/baseline` is `404 not-cached` and
`PUT /diff/shape` is 503, so the site's baseline, link-value, and changelog
cards stay empty.
The compose file includes one (`docker compose up -d minio`); a native
`brew install minio` binary works identically when Docker isn't available:

```bash
# one-time: start MinIO + create the bucket
minio server /tmp/minio-data --address :9000 &          # or: docker compose up -d minio
AWS_ACCESS_KEY_ID=devaccess AWS_SECRET_ACCESS_KEY=devsecret123 \
  aws --endpoint-url http://127.0.0.1:9000 s3 mb s3://shapley-cache

# run BOTH roles with the S3 env added (same vars for api and worker):
S3_CACHE_BUCKET=shapley-cache S3_CACHE_ENDPOINT=http://127.0.0.1:9000 \
AWS_ACCESS_KEY_ID=devaccess AWS_SECRET_ACCESS_KEY=devsecret123 AWS_REGION=us-east-1 \
PORT=8099 REDIS_URL=redis://:devpass@127.0.0.1:6390 cargo run -- api
```

(the native binary needs `MINIO_ROOT_USER=devaccess MINIO_ROOT_PASSWORD=devsecret123`
exported before `minio server`.)

Durable-result loop to verify end-to-end persistence:

1. Submit a `/jobs/simulate` job and poll to `done`. The worker logs
   `stored simulate to S3` and `shapley/v3/simulate-{hash}.json` appears in the
   bucket (`aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://shapley-cache/shapley/v3/`).
2. Delete every `shapley:whatif:state/result/payload` key in Redis (simulates
   the 24 h terminal TTL + 1 h result-cache expiry; keep the stream/group,
   see the flushall pitfall above).
3. Resubmit the identical payload: the API logs
   `what-if job completed from S3` and the **first** poll returns `done`
   through the submit-time short-circuit, with no worker involvement.

A corrupt object is treated as a miss (`failed to deserialize S3 simulate`),
recomputed fresh, and re-stored.

Clear a stuck/backed-up queue with `scripts/queue-clear.sh` (repo root):
`--surgical` drops queued + pending entries and recreates the consumer group in
place (worker keeps running; results kept); `--nuke` wipes the whole
`shapley:whatif:*` keyspace (needs a worker restart); add `--cancel-running` to
stop in-flight sampling solves, `--dry-run` to preview. Targets the dev Redis by
default; set `REDIS_URL` for another instance.

Payload notes: city codes in `demands`/`public_links` must be alpha (no digits);
all demands sharing a `type` need the same `(start, traffic, multicast)`.

## Correctness pin

```bash
cargo test
```

Runs the whole suite (see "Regression tests" below for the Redis it needs).
`tests/upstream_simple.rs` feeds the upstream README's `simple` example to the
engine and checks the values match within 1%; regression there means upstream
changed (bump the `expected_*` constants). `tests/dedup_devices.rs`,
`tests/link_estimate_http.rs`, and `tests/shapley_single_flight.rs` pin the
HTTP contract; `tests/baseline_alias_http.rs`, `tests/alias_publication.rs`,
and `tests/link_estimate_alias.rs` pin alias publication; `tests/diff_parity.rs`
and `tests/diff_persistence.rs` pin the diff index. `tests/parity_epoch149.rs`
(ignored by default) is the historical on-chain golden.

## Deploy

### Build and push

```bash
# Build the image
docker build -t ghcr.io/<owner>/dz-shapley-service:<tag> .

# Push to registry
docker push ghcr.io/<owner>/dz-shapley-service:<tag>
```

### Secrets (out-of-band, kept out of git)

The service reads these from its environment (full table in
[`docs/operations.md`](../../docs/operations.md#4-environment-variables-shapley-service)):

| Variable | Purpose |
|---|---|
| `SHAPLEY_API_TOKEN` | compute bearer token (fail-closed, see below) |
| `SHAPLEY_INGEST_TOKEN` | second token on the publication routes (`X-Ingest-Token`); unset → those routes answer 503 |
| `REDIS_URL` | job queue; required by the worker and by every `/jobs/*` and `/precompute*` route |
| `S3_CACHE_BUCKET`, `S3_CACHE_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | result cache, aliases, markers, diff index |
| `PORT`, `RUST_LOG`, `CORS_ORIGIN`, `LINK_ESTIMATE_SOLVE_THREADS` | transport and tuning |

Generate the secrets once; the Redis password goes in both the URL and your
Redis server config:

```bash
SHAPLEY_API_TOKEN=$(openssl rand -hex 32)
SHAPLEY_INGEST_TOKEN=$(openssl rand -hex 32)
REDIS_PW=$(openssl rand -hex 24)
REDIS_URL="redis://:${REDIS_PW}@<your-redis-host>:6379"
```

The frontend needs the same `SHAPLEY_API_TOKEN` and `SHAPLEY_INGEST_TOKEN`.
Omit `REDIS_URL` to run without the async job API. The synchronous compute
endpoints still work and `/jobs/*` and `/precompute*` return 503, which also
means no baseline can be published.

**Auth is fail-closed by default.** The compute endpoints are served only when
the service can be reached safely:

| `SHAPLEY_API_TOKEN` | `SHAPLEY_ALLOW_UNAUTHENTICATED` | Result |
|---|---|---|
| set | (ignored) | Bearer auth enforced on all compute routes |
| unset | `1` | compute routes open, **local dev only**; logs a warning |
| unset | unset | compute routes **not served** (only `/health`); logs an error |

This means forgetting to set a token on an internet-reachable deploy fails
closed (no open solver) rather than silently exposing one. Likewise,
**`CORS_ORIGIN` unset allows no cross-origin requests** (same-origin only); set
it to your frontend's origin if a browser must call the service directly. (The
reference frontend reaches the service through a server-side proxy, so it is
unaffected by CORS either way.)

### Deploying

The service is a single container (see the `Dockerfile`) that runs on any
orchestrator. The image runs as a non-root user with group-0 (`g=u`)
permissions, so a platform that injects a random UID (OpenShift's restricted
SCC) can execute it; a read-only root filesystem and dropped capabilities are
pod-spec settings and work with it. You'll want: an API deployment (2+ replicas
behind a TLS ingress), a worker deployment (see roles below), a Redis instance
reachable by both, and an S3-compatible bucket reachable by both.

### Roles: API + worker (ADR 0001 Phase 2)

The same image runs in two roles, selected by the first arg (or `--role=`):

- **`api`** (default): the HTTP server. `POST /jobs/simulate` validates,
  persists the request payload to Redis, and `XADD`s a tiny entry onto the work
  Stream (`shapley:whatif:stream`), returning `202 {job_id}`. `GET/DELETE
  /jobs/{id}` read/write Redis state, so any replica serves any job.
- **`worker`**: `args: ["worker"]`. No compute HTTP routes, only `/health`.
  `XREADGROUP`s jobs, runs the cancellable solver (bridging progress/cancel
  through Redis), writes the result + state, and `XACK`s. Crash recovery is an
  `XAUTOCLAIM` reclaim sweep; poison entries (or > 3 deliveries; > 1 for
  link-estimate entries, since an OOM-killed breakdown would re-kill every
  worker it lands on) go to the `shapley:whatif:dead` stream. At-least-once
  delivery is made safe by the `result:{hash}` idempotency cache. The worker
  also expands sweep jobs into per-operator children and publishes baseline and
  link-estimate aliases after their result objects land.



### The diff index needs no egress

`/diff*` is served from per-epoch records under `diff/v1/` in the result-cache
bucket. Records arrive over `PUT /diff/shape/:epoch` from the Vercel cron, gated
by `SHAPLEY_INGEST_TOKEN` on top of the compute token, and
`GET /diff/missing?latest=N&depth=D` tells the cron which epochs it lacks.

The service reads no public bucket, so the pods reach only Redis and the object
gateway. That is deliberate: the cron already downloads each snapshot for the
Shapley sweep, and doing the extraction there means cluster egress to the
public internet never has to be opened. See
[ADR 0003](../../docs/adr/0003-cron-side-snapshot-extraction.md).

### Verify deploy

```bash
curl -fsS "https://<your-service-host>/health"
curl -fsS -H "authorization: Bearer $SHAPLEY_API_TOKEN" \
  "https://<your-service-host>/diff?from=204&to=211" | head -c 200
```

Set `SHAPLEY_SERVICE_URL=https://<your-service-host>` in the frontend's env
to enable the canonical Rust solver.

## Methodology

`/shapley` delegates to `network_shapley::ShapleyInput::compute()`, which
solves multi-commodity flow LPs per coalition with bandwidth, uptime, and
contiguity constraints.

`/link-estimate` delegates to `network_shapley::ShapleyInput::network_link_estimate`,
a faithful port of the Python reference `network_linkestimate`: it retags each
focus-owned link as its own pseudo-operator (collapsing every other operator to
`"Others"` and on/off-ramp helper edges to `"Private"`) and runs ONE exact 2^n
coalition Shapley over those link-players, reusing the warm-start solver. Each
link's `value` is its Shapley value; `percent` is its share of the positive total
(a 0–1 fraction). Single-shot over the whole demand set, not the per-city reward
methodology. Capped at 20 link-players (mirrors Python's `n_ops < 21`); above that
the endpoint returns 422.

Parity is verified against the Python reference in the engine crate
(`tests/link_estimate_test.rs`, value ≤ 0.01 / percent ≤ 1e-4). Large operators
should use `POST /jobs/link-estimate` (progress + cancellation) rather than the
blocking sync endpoint, since a near-cap operator enumerates up to `2^20`
coalitions.

## Regression tests

Use an empty, dedicated Redis database. The publication test refuses an occupied database and cleans up the keys it creates.

```bash
redis-server --bind 127.0.0.1 --port 6390 --save '' --appendonly no
# In another shell, from services/shapley-rs:
TEST_REDIS_URL=redis://127.0.0.1:6390/13 cargo test --locked
```

The default storage tests run a local mock S3 server with the real SDK. Gateway acceptance is separate and requires a disposable `pr24-canary-<UUID>` bucket. See [operations](../../docs/operations.md#alias-publication-rollout) for rollout and historical warm-up.
