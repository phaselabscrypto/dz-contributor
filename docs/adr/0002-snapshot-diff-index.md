# ADR 0002: Snapshot diff index inside the Rust service

- **Status:** Accepted; the ingest half superseded by
  [ADR 0003](0003-cron-side-snapshot-extraction.md) on 2026-09-04
- **Date:** 2026-09-03

> [!IMPORTANT]
> The scanner and poller described below no longer exist. The Vercel cron
> extracts each epoch's record and `PUT`s it, because the canonical Shapley
> input needs both ends of a snapshot and so the cron downloads the whole file
> anyway. ADR 0003 records that change. Everything here about WHY the index is
> immutable S3 records rather than a database still stands.

> Cross-reference: see [`../shapley-service.md`](../shapley-service.md#snapshot-diff-index) for
> the implementation detail (scanner, store, poller, routes). This ADR records the
> decision and its rationale; the code in `services/shapley-rs/src/` is the
> authority on the contract.

## 1. Context

The "Recent change digest" card on `/economics` and the `/changelog` page call
`GET /api/diff?from=&to=`. The Next.js route downloaded a full DoubleZero epoch
snapshot from S3 for `from`, `to`, and every intermediate epoch, then parsed each
with `res.json()` to read the links table. Measured in production on 2026-09-03:

| Measurement | Value |
|---|---|
| One snapshot (epoch 211) | 109,492,960 bytes |
| Snapshots fetched for the digest (7-epoch window, `to` fetched twice) | 9 |
| Cold request, 7-epoch window | 12.6 s |
| Cold request, 21-epoch window | 35.1 s |
| Warm request (same Vercel instance) | 0.4 s |
| CDN cache status | always `MISS` (route sent no `s-maxage`) |

The digest hid itself on any non-2xx. Production non-2xx sources were the 30 s
abort on a download that takes 20 s from a good connection, the 10/min rate
limit, and any function timeout.

The diff needs four of the eight `dz_serviceability` sections. Byte layout
verified on epochs 48, 100, 150, 205, 211 (pretty-printed 2-space JSON, same
key order on every epoch):

| Section | Offset on epoch 211 | Needed |
|---|---|---|
| `dz_epoch` (top level) | 4 | yes |
| `fetch_data.dz_serviceability.locations` | 90 | yes |
| `.exchanges` | 29,680 | no |
| `.devices` | 47,564 | yes |
| `.links` | 1,252,225 | yes |
| `.users` | 1,522,408 | no |
| `.multicast_groups` | 3,706,445 | no |
| `.contributors` | 3,719,711 | yes |
| `.access_passes` | 3,725,669 | no |
| `fetch_data.dz_telemetry` | 9,693,114 | no (about 93 MB) |
| end of file | 109,492,960 | |

A reader that stops after `contributors` closes reads about 3.7 MB. The lean
per-epoch projection (166 links, 15 contributors) is 28 KB as JSON. Snapshots
are immutable per epoch. The bucket is public and answers unsigned requests.

## 2. Decision

Move the diff into the Rust service as a per-epoch index. The service reads
each snapshot once, keeps a 28 KB shape per epoch, and computes every diff from
those shapes. The Next.js routes become thin proxies.

- **Stream and stop.** A second, unsigned `aws_sdk_s3::Client` reads the public
  bucket. A byte-level scanner tracks JSON depth and captures the four wanted
  sections as they stream. It stops when the fourth section closes or when
  `dz_serviceability` closes, then drops the stream. `MAX_SCAN_BYTES` (32 MiB)
  is a hard ceiling; a layout change that moves the sections after the
  telemetry arrays fails with `BudgetExceeded` instead of reading 110 MB.
- **One shape per epoch in S3.** The extractor reduces the sections to a
  `DiffShape` and writes it as `diff/v1/shape-{epoch:06}.json` in the existing
  result-cache bucket. The key is immutable. `DIFF_SHAPE_VERSION_PREFIX` is
  independent of the LP engine's `shapley/v3` prefix.
- **Three-tier read with single-flight.** `DiffStore::get` checks memory, then
  S3, then ingests. Concurrent misses for one epoch share one ingest. A failure
  is never cached. CPU work (parse and extract) runs under `spawn_blocking`.
- **Poller in the worker, plus a one-shot role.** The `worker` role discovers
  the latest epoch every 15 minutes and ingests every missing epoch. The
  `diff-backfill` role runs the same fill once and exits, so the initial fill
  can be watched from a terminal.
- **Service-to-service auth only.** The `/diff*` routes sit behind the existing
  `SHAPLEY_API_TOKEN` gate. The public `/api/diff*` routes on Vercel stay
  unauthenticated, rate limited at `RATE_LIMIT_STANDARD`, and send
  `Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=604800`.
- **Both response shapes are preserved.** Field names, ordering rules, and the
  three validation messages match the TypeScript route byte for byte, except
  that the contributor display name is added by the proxy because the service
  has no copy of `CONTRIBUTOR_NAMES`.

### Why the index is S3 objects

The data is one immutable 28 KB record per epoch. There are about 165 today,
and one more arrives every 38 to 44 hours. Each is read by key. None is ever
updated or joined.

| | S3 object per epoch (chosen) | Postgres | SQLite on PVC | Redis (existing) |
|---|---|---|---|---|
| New infrastructure | none; bucket and credentials already wired into both deployments | a Postgres instance (bitnami HA chart), secrets, backups, monitoring | a ReadWriteMany volume shared by the `api` and `worker` deployments (CephFS), or one copy per pod that drifts | none |
| New Rust dependencies | none | `sqlx` or `sea-orm` plus a driver: 7-day cooldown and a dependency PR | `rusqlite` | none |
| Schema and migrations | none; the version prefix is the schema | migrations directory, entity code, a migration step in deploy | same as Postgres | none |
| Read path for a diff | 2 to 22 `get_object` calls of 28 KB, 10 to 30 ms each in-cluster, then in-memory compute; memory tier makes repeats about 1 ms | one or two indexed queries, similar latency, plus a connection pool | file reads | not durable: production Redis runs with `--save ""` and `--appendonly no`, so the index would vanish on restart |
| Write path | idempotent `put_object`, no transaction needed because records are write-once | insert with a unique constraint | insert | n/a |
| Durability | Ceph object gateway, same guarantee the Shapley result cache relies on today | Postgres HA | volume | none |
| Multi-replica | trivially correct: same key, same bytes | correct | fragile | n/a |
| Ad hoc questions ("when did link X change", "bandwidth per contributor over 100 epochs") | computed in-process by loading shapes; all 165 shapes are about 5 MB and fit in memory, so a full scan is milliseconds | SQL; the natural home for these once they exist as product features | SQL | n/a |
| Operational surface | zero additional | a stateful service that is idle 99.9% of the time at this volume (under 100k rows total) | small | n/a |

A database becomes the right answer if the product grows per-link timelines
served at scale, cross-epoch aggregations with pagination, or joins with
rewards data. The S3 shapes are already the ingest output, so a table can be
filled from them without re-reading a snapshot.

## 3. Alternatives considered

- **Next.js-only streaming plus Vercel Data Cache.** Rejected. A streaming
  parser in the route still runs inside a Vercel function on every cache miss,
  and the Data Cache is per region and expires, so every region pays the first
  fetch and the fetch recurs. The digest needs 9 fetches per cold request. The
  service already has the S3 client, a long-lived process, and a bucket, so the
  index is cheaper to hold there and is filled once, not once per region.
- **A new Loco.rs service with Postgres.** Rejected. It adds a second Rust
  service, a Postgres instance, migrations, and a dependency PR for the ORM, to
  hold under 100k rows that are never updated or joined. The existing service
  has spare capacity and the same deploy pipeline.
- **SQLite on a PVC.** Rejected. The `api` and `worker` deployments would need
  a shared ReadWriteMany volume, or each pod keeps its own copy that drifts.
  The object store gives multi-replica correctness with no coordination.
- **Redis.** Rejected. Production Redis runs with persistence disabled, so the
  index would vanish on every restart and the poller would re-read every
  snapshot from the public bucket.

## 4. Consequences

- **Cluster egress to public S3 is required.** The pods add HTTPS to
  `doublezero-contributor-rewards-mn-beta-snapshots.s3.us-east-1.amazonaws.com`.
  If a NetworkPolicy or egress firewall blocks it, the poller logs the failure
  on every tick and the index never fills. The fix is a cluster-side egress
  rule, not a code change.
- **The Rust service deploys before the Next.js proxy.** The service is
  deployed and `GET /diff?from=204&to=211` is verified with the bearer before
  the proxy change merges. Merging the proxy first turns every diff into a 502.
- **`DIFF_SHAPE_VERSION_PREFIX` bump discipline.** Bump `diff/v1` when
  `DiffShape` fields change, when the extractor's emitted values change, or
  when the set of scanned sections changes. A bump orphans the old objects and
  triggers a refill of about 165 epochs (2 to 5 minutes) on the next poller
  tick or `diff-backfill` run. The LP engine's `shapley/v3` prefix and this
  prefix move independently.
- **The TypeScript diff logic is removed, with no fallback.** `lib/utils/snapshot-diff.ts`
  is deleted. If `SHAPLEY_SERVICE_URL` is unset the `/api/diff*` routes return
  503. This follows the no-silent-fallback policy in
  [`../architecture.md`](../architecture.md#method-labels) and avoids two diff
  implementations that must agree.
- **A layout change fails loudly.** If DoubleZero moves `dz_serviceability`
  after the telemetry arrays, ingest for that epoch fails with `BudgetExceeded`
  at 32 MiB. There is no fallback to a full parse. The fill backs such an epoch
  off on a doubling delay from 15 minutes to a 24 hour cap, so a permanent
  layout change costs about one attempt a day per affected epoch instead of one
  every tick.
- **Ingest concurrency is capped process-wide.** `MAX_CONCURRENT_INGESTS` (6)
  is held across the stream and the parse, so the resident section bytes and
  the blocking-pool queue are bounded by that count rather than by how many
  requests arrive. Per-epoch single flight in `DiffStore::get` already collapses
  duplicate demand for one epoch.
- **A degraded diff is not cached.** An intermediate epoch that misses its 6 s
  read deadline is skipped and attribution falls back to `to`, as before, but
  the response now carries `x-diff-degraded: 1` and the proxy serves it
  `no-store`. Only a diff computed from every intermediate gets the 24 hour
  `s-maxage`.
- **A missing `to` epoch is a 404, not a 502.** The service returns 404 and the
  proxy forwards it. No consumer branches on 502.
