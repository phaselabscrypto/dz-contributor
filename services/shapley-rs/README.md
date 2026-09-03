# dz-shapley-service

Rust HTTP wrapper around the canonical
[`network-shapley-rs`](https://github.com/doublezerofoundation/network-shapley-rs)
crate. Built so the Next.js frontend can call a single endpoint and get
LP-correct Shapley values without bundling a Rust solver client-side.

## Endpoints

```
GET  /health           -> { status, service, version }
POST /shapley          -> ShapleyResponse        { method, operator_count, values }
POST /link-estimate    -> LinkEstimateResponse   (faithful retag-Shapley; sync, S3-served when precomputed)
POST /jobs/link-estimate -> 202 { job_id }       (async: progress + cancel via /jobs/:id; done-at-submit on S3 hit)
POST /precompute/link-estimates -> { enqueued, cached, skipped }   (epoch sweep)
```

### Epoch precompute sweep

Epoch inputs are immutable, so each `(epoch, operator)` link-estimate is
computed once and persisted to S3 (`shapley/v3/link-estimate-{payload_hash}.bin`,
keyed by the job payload hash). The Vercel cron `GET /api/link-value/precompute`
(authed via `CRON_SECRET`) builds the epoch input and calls the sweep, which
enqueues one job per operator:

```bash
curl -fsS -X POST "$BASE/precompute/link-estimates" \
  -H "authorization: Bearer $SHAPLEY_API_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary '{ "input": { ...ShapleyInputIn... }, "operators": ["Alpha", "Beta"] }'
# -> { "enqueued": [{"operator":"Beta","job_id":"..."}], "cached": ["Alpha"],
#      "skipped": [{"operator":"Gamma","reason":"22 links exceeds the 20-player exact cap (19 max)"}] }
```

Omit `operators` to derive them from the input's devices. The response is fully
transparent: every operator lands in exactly one bucket. Operators above the
19-link exact cap are reported in `skipped`, never silently dropped.

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
| `demands` | 1,000 |

Request body limit: **2 MB**.

## Local development

```bash
cargo run --release
# in another shell
./tests/smoke.sh
```

`smoke.sh` hits `/health`, `/shapley`, and `/link-estimate` against the
`tests/fixtures/simple.json` payload and asserts the Shapley values match
the upstream README within 1%.

### Local async testing (`/jobs/*`)

The async path needs Redis plus **both** roles: the `api` role enqueues onto a
Redis Stream and a `worker` role drains it. Run only `api` and jobs sit at
`running` forever (nothing consumes the stream).

`docker-compose.yml` brings up Redis (the service stays on the host so
`cargo` resolves the `network-shapley` path dep and rebuilds incrementally):

```bash
docker compose up -d                                          # Redis on :6390
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
curl -fsS -X DELETE localhost:8099/jobs/$JOB  # cancel — only bites a sampling job (>10 operators)
```

Inspect the queue with `redis-cli -p 6390 -a devpass keys 'shapley:whatif:*'`;
tear down with `docker compose down`. To test the compute (no Redis/queue),
hit the synchronous `POST /simulate` on the `api` process instead.

> **Pitfall:** `redis-cli flushall` deletes the Stream **consumer group**, and
> the worker only creates it at startup. After a flush it spins on
> `xreadgroup failed; backing off` until restarted. Prefer
> `scripts/queue-clear.sh --surgical` (recreates the group in place), or
> restart the worker after a flush.

### Local S3 testing (durable result cache)

The S3 layer (baseline cache, link-estimate results, simulate results; the
persistence behind shareable forecast URLs) targets any S3-compatible endpoint
via `S3_CACHE_ENDPOINT` (path-style), so MinIO models production faithfully.
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

1. Submit a `/jobs/simulate` job and poll to `done`: the worker logs
   `stored simulate to S3` and `shapley/v3/simulate-{hash}.json` appears in the
   bucket (`aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://shapley-cache/shapley/v3/`).
2. Delete every `shapley:whatif:state/result/payload` key in Redis (simulates
   the 24 h terminal TTL + 1 h result-cache expiry; keep the stream/group,
   see the flushall pitfall above).
3. Resubmit the identical payload: the API logs
   `what-if job completed from S3` and the **first** poll returns `done`:
   the submit-time short-circuit, no worker involvement.

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

The engine is pinned at fork tag `phase-2026.09` (`services/shapley-rs/Cargo.toml`),
based on upstream `network-shapley-rs` v0.6.0.

```bash
cargo test
```

Runs `tests/upstream_simple.rs`, which feeds the upstream README's `simple`
example through our `build_input` + `compute` and checks the values match
within 1%. Regression here means either upstream changed (bump the
`expected_*` constants) or our wire-type translation drifted.

## Deploy

Build, push, secrets, deployment topology, and role rollout order live in
[`docs/operations.md`](../../docs/operations.md), section 2.

The container runs as a non-root user with a read-only root filesystem and
all capabilities dropped, so it satisfies platforms that run containers as a
random non-root UID out of the box.

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
(a 0–1 fraction). Single-shot over the whole demand set (NOT the per-city reward
methodology). Capped at 20 link-players (mirrors Python's `n_ops < 21`); above that
the endpoint returns 422.

Parity is verified against the Python reference in the engine crate
(`tests/link_estimate_test.rs`, value ≤ 0.01 / percent ≤ 1e-4). Large operators
should use `POST /jobs/link-estimate` (progress + cancellation) rather than the
blocking sync endpoint, since a near-cap operator enumerates up to `2^20`
coalitions.
