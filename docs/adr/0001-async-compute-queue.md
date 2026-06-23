# ADR 0001 — Externalized async compute queue (Redis Streams + always-warm workers)

- **Status:** Accepted (recreated for public release from the original internal ADR, 2026-06-13)
- **Date:** 2026-06-02
- **Supersedes:** the in-process tokio `Semaphore` + per-process `JobRegistry` from the earlier async-job work.

> Cross-reference: see [`../shapley-service.md`](../shapley-service.md) for the
> current implementation detail (route handlers, the worker loop, the Redis
> keyspace as shipped). This ADR records the *decision* and its rationale; the
> code in `services/shapley-rs/src/` is the authority on the contract.

## 1. Context

The interactive what-if (`POST /jobs/simulate`) originally ran the heavy Shapley
solve **in-process**, gated by a tokio `Semaphore`, with job state in a
per-process `HashMap`. Two problems drove this decision:

1. **A semaphore is a concurrency *limiter*, not a scaling primitive.** It is
   bounded to one process's cores. It can shed or queue work *within* a single
   process, but it cannot absorb demand by adding capacity — there is no knob
   that turns "more load" into "more compute."
2. **Per-process job state breaks under ≥ 2 replicas.** A job created on replica
   A is invisible to replica B, so a poll or cancel routed to the wrong replica
   returns `404`. The S3 cache shares *finished results* across replicas, but
   not *in-flight* state (progress, cancellation, running/failed).

We needed (a) compute that scales on demand and (b) correct multi-replica
poll/cancel. Two workloads pull in opposite directions:

| | Cold per-epoch batch precompute | Interactive what-if |
|---|---|---|
| Cadence | once per ~2–3 days (per epoch) | frequent, bursty |
| Duration | minutes (~2,500 LPs) | seconds to a minute |
| Latency need | none (background) | snappy |
| Best fit | **a scheduled job** | **always-warm worker pool + queue** |

The batch job is latency-insensitive and rare, so it belongs on a schedule. The
interactive path is bursty and latency-sensitive, so it wants a warm pool of
workers fed by a queue.

## 2. Decision

Externalize the interactive path into independently-scalable tiers, plus a
separate batch path:

- **Stateless API tier (axum).** `POST /jobs/simulate` validates, builds the
  input, persists the request payload, `XADD`s a tiny reference entry, and
  returns `202 { job_id }`. `GET /jobs/{id}` and `DELETE /jobs/{id}` read/write
  Redis state, so **any replica serves any job**. The tokio `Semaphore` and the
  in-process `JobRegistry` are removed — concurrency is now the worker count.
- **Redis as both the queue *and* the live state store.** One Stream + consumer
  group is the durable queue; the same Redis instance holds per-job
  state/progress and the cancel flag. Using one dependency for both is the
  low-lift choice — no second system to run, secure, and monitor.
- **Always-warm worker pool.** A separate process (same binary, `--role=worker`)
  consumes the Stream via `XREADGROUP`, runs the existing cancellable solver,
  bridges progress + cancellation through Redis, persists the result, and
  `XACK`s. The pool is kept warm (a minimum of one worker) so there is no
  cold-start penalty on the interactive path.
- **Scale the worker pool on stream backlog.** Use a queue-depth autoscaler
  (e.g. KEDA's `redis-streams` trigger) so the worker count tracks the
  never-delivered backlog. Always-warm is the floor; the deploy-time maximum is
  the budget ceiling.
- **Batch precompute is a scheduled job.** Baseline precompute runs on a
  schedule against `POST /precompute`, off the interactive queue entirely.

What we **reuse unchanged**: the solver crate's `ComputeControl` (cancel +
progress) — only its *transport* changes from in-process atomics to Redis; the
warm-start solver; and the S3 result cache keyed by the topology `input_hash`,
which gives idempotency for free under at-least-once delivery.

### Architecture sketch

```text
                 XADD (ref only)         ┌──────────────────────────────┐
  client ─────▶  API tier  ───────────▶  │ REDIS                        │
  poll / cancel  (axum,                   │  • stream  (queue + group)   │
        ▲        stateless)  ◀─ HGETALL ─ │  • payload:{id}  (TTL)       │
        │                       (poll)    │  • state:{id}    (HASH, TTL) │
        │            │  SET cancel:{id} ─▶│  • cancel:{id}   (TTL)       │
        │            └──────────────────▶ │  • result:{hash} (TTL)       │
        │                                 └───────────────┬──────────────┘
        │                                   XREADGROUP >   │ XACK on terminal
        │                                                  ▼
        │                                 ┌──────────────────────────────┐
        └──── result via state:{id} ───── │ WORKER POOL (always-warm)    │
                                          │  XREADGROUP → solve → XACK    │
                                          │  progress + cancel bridge     │
                                          │  scaled on stream backlog     │
                                          └───────────────┬──────────────┘
                                                          └─ result ─▶ S3
                                                             (keyed by input hash)

  BATCH (separate): scheduled job ─▶ POST /precompute ─▶ baseline solve ─▶ S3 cache
```

Payloads are **stored-and-referenced**: the heavy `SimulateRequest` (the
baseline + modified topologies, on the order of megabytes) goes into a TTL'd
Redis String, and the Stream entry carries only a reference to it. Streams live
fully in RAM and unacked entries linger in the Pending Entries List, so inlining
the body would bloat memory and every reclaim scan.

## 3. Mechanics (as shipped)

These are the contract as implemented in `services/shapley-rs/src/queue.rs`
(the single source of truth for every key name and constant, shared verbatim by
the `api` and `worker` roles) and `services/shapley-rs/src/jobs.rs`.

### Redis keyspace

```text
shapley:whatif:stream            STREAM  capped XADD MAXLEN ~ 10000; group `whatif-workers`
shapley:whatif:dead              STREAM  dead-letter (delivery count > 3, or unknown schema)
shapley:whatif:payload:{id}      STRING  serde-JSON request; TTL 3600s (a sweep's shared
                                          payload gets 24h, refreshed on each child pickup)
shapley:whatif:result:{hash}     STRING  serialized response; TTL ~3600s (idempotency cache)
shapley:whatif:state:{id}        HASH    {state, coalitions_solved, samples_done, max_samples,
                                          percent, phase?, result?, error?} plus internal batch_*
                                          progress-interpolation counters; whole-key TTL 1800s,
                                          heartbeat-refreshed
shapley:whatif:cancel:{id}       STRING  "1"; separate cancel key (TTL 1800s)
shapley:linkest:inflight:{hash}  STRING  job_id; SET NX EX 86400s (in-flight dedup)
```

- **Store-and-reference payloads.** The API persists the request under
  `payload:{id}` with a 3600s TTL, then `XADD`s a tiny entry holding only
  `{job_id, payload_key, input_hash, enqueued_at, schema, kind}` (plus an
  optional `focus` operator on sweep-spawned children). A sweep's
  shared payload uses a 24h TTL and the worker refreshes it (`EXPIRE`) on every
  child pickup, so a deep queue can never out-wait the payload.
- **State hash, heartbeat-refreshed.** `state:{id}` carries the whole job
  snapshot with a **1800s** whole-key TTL, re-set on every progress/phase
  heartbeat and on each terminal write. *(Amended in implementation: the
  original ADR specified 600s; that was too low — a job queued behind a couple
  of ~15-minute solves expired before a worker first heartbeated. The code
  ships 1800s and the code wins.)*
- **Separate cancel key.** `DELETE /jobs/{id}` does `SET cancel:{id} 1 EX …`.
  The cancel flag lives in its **own key**, never in the state hash, so a
  progress flush (a multi-field `HSET` of counters only) can never clobber a
  concurrent cancel via last-writer-wins. State transitions are written only by
  the worker at claim and at terminal; progress writes touch counters only.
  *(The original ADR set the cancel-key TTL to 600s; the shipped code re-uses
  the job TTL, 1800s — code wins.)*
- **Idempotency cache.** Before computing, the worker checks `result:{hash}`
  (~3600s TTL) and the S3 result cache; on a hit it republishes the cached
  result verbatim and `XACK`s without recomputing. This is what makes
  at-least-once delivery safe — no separate dedup table, just the input hash.
- **Consumer group + long-poll.** Group `whatif-workers`, created idempotently
  via `XGROUP CREATE … $ MKSTREAM` (a `BUSYGROUP` on re-create is expected and
  ignored). Each worker reads one job at a time (`COUNT 1`) with `BLOCK 5000ms`,
  so an idle worker parks cheaply.
- **Dead-worker recovery (at-least-once).** A periodic `XAUTOCLAIM` sweep
  reclaims entries idle longer than **30s** — only entries left pending by a
  *dead* worker cross that threshold, because a live worker heartbeats its claim
  (an `XCLAIM … JUSTID`, which does not advance the delivery counter) well under
  the 30s window. The reclaim path does not use `JUSTID`, so the delivery
  counter advances and feeds the poison-pill guard.
- **Dead-letter stream.** An entry redelivered more than **3** times (read from
  `XPENDING`), or one whose schema the running binary does not recognize, is
  moved to `shapley:whatif:dead` and `XACK`'d off the work stream
  (alert-and-drop; retained for inspection).
- **Schema version tags.** Each entry is stamped with a per-kind schema tag —
  `whatif/v1`, `linkest/v1`, `sweep/v1`, `baseline/v1`. A worker that reads a tag
  it does not understand dead-letters the entry immediately rather than
  mis-deserializing a payload from a newer or older producer. So a mixed-version
  rollout **fails accurately** ("unsupported job schema") instead of burning
  blind retries on a misread payload.
- **In-flight dedup.** A link-estimate solve claims
  `shapley:linkest:inflight:{hash}` via `SET NX EX` before running; a duplicate
  submission (e.g. a sweep child and a UI request for the same operator) attaches
  to the running job's id instead of launching a second multi-minute solve. The
  worker clears the claim on every terminal state; the TTL is only a crash
  backstop. (The S3 cache dedups *completed* work; this covers the *in-flight*
  window.)

### Roles (one binary, `--role={api,worker}`)

The same binary runs as either role (`services/shapley-rs/src/main.rs`), sharing
the model types, cache, solver crate, auth, and `build_input`. The `api` role
serves HTTP (sync compute endpoints plus the async `/jobs/*` surface); the
`worker` role runs only a `/health` listener for probes plus the
`XREADGROUP` consume loop (`services/shapley-rs/src/worker.rs`). A SIGTERM stops
both gracefully, letting an in-flight cancellable solve wind down; anything
interrupted is recovered by the reclaim sweep.

## 4. Alternatives considered

- **Stay on the semaphore + sticky routing.** Rejected: it keeps the single-
  process compute ceiling (the core problem), and sticky sessions to pin a job
  to the replica that created it are fragile and fight horizontal scaling.
- **A full message broker (e.g. RabbitMQ / SQS).** Rejected: it adds a *second*
  dependency when Redis is already required for the live state/cancel/progress
  store. Redis Streams + a consumer group cover the queue needs (capped backlog,
  consumer groups, pending-list reclaim, dead-lettering) at no extra operational
  surface.
- **One pod per job.** Rejected: per-job pods pay a cold-start cost on every
  request, which loses against an always-warm pool for an interactive,
  latency-sensitive workload. A long-lived pool also keeps process state and
  caches hot.

## 5. Consequences

- **New Redis dependency.** The `/jobs/*` surface and the worker require Redis;
  without `REDIS_URL` the async endpoints degrade to `503` (fail-loud), while
  the synchronous endpoints (`/shapley`, `/simulate`, `/link-estimate`) are
  unaffected. A single Redis instance is a SPOF for the interactive path; the S3
  baseline cache is independent of Redis, so already-computed epoch baselines
  still serve. Replication + persistence are a follow-up, not a launch blocker.
- **At-least-once semantics.** A reclaimed entry can be delivered more than once,
  so correctness rests on idempotency via input hashing (the `result:{hash}`
  cache and the S3 cache), plus the dead-letter guard for poison pills.
- **Horizontal worker scaling is now a deploy-time knob.** The worker maximum is
  the budget ceiling; raising it is a configuration change, not a code change.
- **Eventually-consistent progress/cancel.** Progress and cancellation flow
  through Redis on a ~250ms bridge tick rather than in-memory atomics, so they
  are eventually consistent (sub-second) rather than instantaneous.
- **Observability.** Backlog and stuck entries are visible via `XPENDING` and
  the dead-letter stream; `scripts/queue-clear.sh` provides surgical
  (drop-queued-and-pending) and full-wipe operations for the
  `shapley:whatif:*` keyspace.

## 6. Amendments (2026-06-12)

The precompute path (the last heavy-compute surface still running API-side) was
moved onto this queue, with the following changes — each grounded in the current
code:

- **Payload store-and-reference.** Stream entries carry references, not bodies;
  the heavy request lives in a TTL'd `payload:{id}` String. A sweep stores the
  epoch input **once** (24h TTL) and fans out children that all reference it.
- **Separate cancel key (race fix).** Cancellation moved to its own
  `cancel:{id}` key so a progress flush can never clobber a concurrent cancel
  (the state hash is written only at claim and terminal).
- **Schema versioning.** Per-kind schema tags (`whatif/v1`, `linkest/v1`,
  `sweep/v1`, `baseline/v1`) make mixed-version rollouts fail accurately instead
  of mis-deserializing.
- **Reclaim tuning matched to termination grace.** The `XAUTOCLAIM` min-idle
  window (30s) is aligned to the worker's termination grace period and sits
  comfortably above a normal solve, so only genuinely abandoned entries are
  reclaimed; live workers heartbeat their claim to stay under it.
- **Result-cache republication for duplicate submissions.** A redelivery (or a
  duplicate submit) that finds a cached result republishes it verbatim and
  `XACK`s, and link-estimate solves additionally take an in-flight dedup claim
  (`shapley:linkest:inflight:{hash}`) so the same multi-minute solve never runs
  twice.
