# ADR 0003 — The cron extracts snapshots, the service stores records

Status: accepted, 2026-09-04
Supersedes the ingest half of [ADR 0002](0002-snapshot-diff-index.md). The
record-versus-database decision in 0002 stands unchanged.

## Context

ADR 0002 put a byte-level snapshot scanner in the Rust service. It worked
because the diff needs four `dz_serviceability` sections that all sit in the
first 3.7 MB of a snapshot, so the scanner could drop the connection early and
read 3.7 MB instead of 110 MB.

Then `/link-value` needed the same treatment. It takes about 6 seconds on a warm
cache hit, because the answer's S3 key is a hash of the 145 KB canonical Shapley
input, so the route downloads the whole snapshot and rebuilds that input purely
to name an object it already holds.

The scanner does not transfer. Measured on epoch 190, 113,615,007 bytes:

| Section the canonical builder reads | Offset |
|---|---|
| `locations` through `contributors` | 96 to 3,603,701 |
| `dz_telemetry.device_latency_samples` | 9,466,668 |
| `dz_internet.internet_latency_samples` | 106,998,956 |
| `metro_prices`, `start_us`, `end_us` | 113,572,635 |
| `leader_schedule` | 113,574,524 |

The input needs both ends of the file. There is no byte to stop at, and
`MAX_SCAN_BYTES` was 32 MB, so the scanner would have refused the read outright.

Meanwhile the Vercel cron has been downloading each snapshot once per epoch all
along, for the Shapley sweep. It checks the sweep marker first and returns in
under 2 s when an epoch is done, so the 113 MB pull happens about once per
epoch, which is exactly the cadence a per-epoch diff record needs.

## Decision

The cron extracts the diff record during the pass it already runs and pushes it
to the service. The service stops reading the public snapshot bucket.

Deleted: `src/snapshot.rs` (845 lines), `src/diff_poller.rs` (285),
`tests/diff_scanner.rs` (573), `tests/common/mod.rs` (504), and the extractor
half of `src/diff.rs`.

Kept: the record store, the pure diff computations, the HTTP routes, and the
S3 timeout configuration from `207d6ac`.

Added: `PUT /diff/shape/:epoch` to accept a record, and
`GET /diff/missing?latest=N&depth=D` so the cron can ask what it lacks.

### Why not keep the poller

An OKD CronJob or the existing poller both require the `dz-shapley` pods to
reach the public internet. That egress is unverified: the pods currently reach
only in-cluster Redis and the object gateway, and ADR 0002's deploy notes flag
it as an open question. Doing the download outside the cluster means the
question never has to be answered.

### Why push rather than pull

Vercel holds no credentials for the record bucket. It is an in-cluster
S3-compatible gateway addressed by Service hostname with ObjectBucketClaim
credentials, so only the service can write there.

### Why a second token

`SHAPLEY_API_TOKEN` buys a compute. Writing a record that every later reader is
served is a different power, and one token for both would grant it to anyone who
can call `/shapley`. `SHAPLEY_INGEST_TOKEN` gates the write routes on top of the
compute token, so a write must clear both. Unlike the compute token, an unset
ingest token refuses with 503 rather than passing through: running the solver
open locally is a convenience, running a public write endpoint open is not.

HMAC body signing was considered and rejected. It needs `hmac`, `sha2` and `hex`
under the 7-day dependency cooldown, to protect a channel already inside TLS
with a create-only guard on the far side.

### Why writes are create-only

Epochs are immutable, so no legitimate caller rewrites one. A second write of a
readable record is a 409. This caps a leaked ingest token to filling epochs
nobody has ingested yet, which is visible and repaired by a version bump.

Storage reads distinguish absence, readable data, and proven-corrupt bytes. Transport failures remain errors. Creation uses `If-None-Match: *`. Repair uses `If-Match` with the ETag from the corrupt GET response. A corrupt object without an ETag cannot be repaired automatically. A lost condition becomes HTTP 409 only after a readable winner is verified.

The deployed object gateway must enforce these conditions. The ignored `gateway_conditional_contract` test checks this in a disposable bucket before rollout. A process lock cannot protect concurrent API replicas; a lease without a storage predicate cannot fence a delayed writer.

### Canonical publication

`POST /precompute/link-estimates` also requires both tokens. The API records `is_canonical_publish_authorized` in the shared sweep payload. Legacy payloads default to false. Publication requires this authority and a service-derived complete operator set.

Aliases and sweep markers use `shapley/v3/canonical/v1/`. Readers never fall back to legacy metadata because its origin cannot be established. Solver result keys and the numerical input stay unchanged. Historical aliases need explicit warming.

Workers await result persistence before alias persistence. A sweep writes its marker only after every eligible cached operator's alias succeeds. Subsequent sweeps reconcile failures from S3 or the one-hour Redis result cache. A valid numerical result remains usable when publication fails. Claim heartbeats cover the full job, including reads and awaited writes, and stop before terminal state handling.

### Cron scheduling and identity

The shared snapshot loader checks `dz_epoch` against the requested epoch before extraction or submission. Cron, backfill, and fixture verification use that loader.

The cron checks sweep and shape state concurrently. It downloads the current snapshot once, submits current work, then attempts historical repairs. Discovery and service calls count against a 270-second work deadline inside the 300-second function limit. Historical work has a 90-second budget and a 40-second limit per attempt. Each fire permits at most three shape attempts, including the current shape. One historical slot selects the newest gap; remaining slots rotate every six hours.

Gap discovery reads durable records with concurrency eight, a two-second per-read timeout, and a ten-second whole-query timeout. Corruption is a repair candidate. Unknown storage state fails the query.

## Consequences

The diff index now depends on a Vercel cron. A broken cron stalls the sweep and
the changelog together, where before the poller was independent. Freshness for a
newly published epoch moves from 15 minutes to 6 hours; epochs land about every
40 hours, so a new one appears within a quarter of an epoch.

On-demand ingest is gone, so an epoch nobody wrote is a 404 rather than a slow
first request. The changelog selector offers the latest 31 epochs from the
snapshot bucket, not from the diff index, so the cron schedules bounded repairs across that window. `scripts/backfill-diff-shapes.ts`
fills the deeper history once.

Extraction correctness moved to TypeScript, so the Rust parity test can no
longer catch a drifting extractor on its own. `tests/diff_parity.rs` asserts the
response bodies against the production captures using committed shape fixtures,
and `pnpm run test:diff-shape` regenerates those fixtures from the real
snapshots and fails on any difference. Together they cover what the single live
test used to.
