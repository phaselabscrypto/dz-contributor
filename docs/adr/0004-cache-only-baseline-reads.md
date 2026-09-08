# ADR 0004 — Browser-driven Shapley reads are cache-only

Status: accepted, 2026-09-08

## Context

Three GET routes reachable from a page load started a full Shapley solve
whenever the result was not cached: `/api/shapley/baseline`,
`/api/shapley/tracking` and `/api/shapley?epoch=N`. A cold solve is the
production-size problem (15 operators, 32,768 coalitions, an LP of about 28,000
columns per coalition) and takes minutes. Tracking ran eight of them in sequence
per request, and overlapping SWR refreshes solved the same epoch more than once
at a time.

On 2026-09-08 a local run with an empty cache held a debug-build service at 14
cores for most of an hour, from one visit to `/economics`. In production the
same path is normally hidden behind cache hits, and shows up as a "warming"
spinner plus wasted API-pod CPU in the window after each new epoch.

## Decision

Readers never compute. They ask the Rust service for one epoch's published
baseline and answer in milliseconds with the result or a small `not-cached`
body. Only the precompute cron and the worker compute.

### Baselines are addressed by an epoch tag, not by input hash

The service's cache key is a hash of the full solver input, and building that
input means a ~110 MB snapshot download, so a fast probe cannot derive it. The
cron therefore publishes an alias per epoch, keyed on
`baselineTag(epoch) = "baseline:" + sweepTag(epoch)`, under
`shapley/v3/publication/v1/`. This extends the alias machinery link-value
already uses.

There is one alias per epoch. The alias body records
`variant: "foundation" | "snapshot"` so provenance stays visible, but the
reader asks one question per epoch rather than probing the cron's preference
order itself. Keying by `(tag, variant)` would double the probe count, which at
tracking's N=16 is 32 requests instead of 16.

### The read route is a cache-only GET that never computes

`GET /shapley/baseline?tag=` sits on the compute router and references no
`compute_*`, no `enqueue` and no epoch cache. Publication is a separate,
ingest-gated `POST /precompute/baseline`. Adding a `tag` to the existing
`/precompute` was rejected: that route sits on the compute router, so anyone
holding the compute token could publish an alias for any tag.

### A miss is HTTP 404 with a typed body

`404 {status:"not-cached", …}` with `Cache-Control: no-store`. A hit is 200.

202 was rejected because it passes `res.ok`, so a shared SWR fetcher would hand
a miss body to consumers typed as data. That is the exact bug class the old
`baselineFetcher` existed to dodge, and nothing was "accepted" anyway. 204 was
rejected because it carries no body, so `res.json()` throws in every fetcher and
the response cannot name the epoch or the tag.

404 fails closed: a consumer that forgets the guard gets an error rather than a
lie. The SWR fetcher treats a 404 as data only when the body carries
`status:"not-cached"`.

### Tracking is "the cached baselines among the latest N"

The route probes the latest `count` epochs concurrently. Two or more hits is a
200 carrying `epochs` and `missingEpochs`, and the widget renders and names what
is missing. Fewer than two is a 404 and the widget hides. Any probe error, as
distinct from a miss, is a 502.

Requiring all N would leave the 12- and 16-epoch picker options dead until the
backfill finished, and the picker lives inside the widget, so a hidden widget
leaves no way back.

### No cache hit, no component

A widget with no published baseline renders nothing rather than a spinner or a
zero. `livePct` becomes `number | null`, and the contributors table drops the
"Live share" column entirely instead of showing a column of dashes: sorting
zeros reorders nothing, and a header invites the click.

### The dead TypeScript compute path is deleted

With no reader computing, the shared per-epoch compute helper and its LRU and
in-flight map, its typed service error, the soft-failure remote wrapper, the
in-process TypeScript solver, the single-epoch SWR hook and the 202-warming
contract all have no callers. They are removed. What remains of the compute
helper is input building for the cron, so it is now `lib/utils/epoch-input.ts`.

`app/api/shapley/simulate/route.ts` still solves synchronously on a cold epoch.
That is a separate ticket and out of scope here.

## Consequences

An epoch is visible only after the cron has published it. Deploy order matters:
the Rust image ships first, because until the read route exists the probe gets a
plain 404 with no typed body, which the TypeScript side correctly treats as a
service error. Nothing computes and nothing hangs; the two economics widgets
show their one-line error state and the contributors table has no live column.

After deploy, the aliases for historical epochs exist only once the cron has
fired for each. The backfill is an ops step, documented in
[operations.md](../operations.md#backfilling-baseline-aliases). An epoch whose
result is already cached under its input hash is aliased without a solve.

`SHAPLEY_SERVICE_URL` unset now yields 503 from all three routes, as the diff
routes already do. There is no local-development solver behind them any more.

The three routes move from `RATE_LIMIT_HEAVY` to `RATE_LIMIT_STANDARD`: they are
cache-read proxies now, the same class as the diff proxies. The cron and
simulate routes keep the heavy limit.

Module-level caches in the routes are gone, along with the baseline route's
last-good fallback. A five-minute last-good cache buys nothing on a millisecond
probe, and it hid outages behind quiet 200s.
