# services/shapley-rs TODO

Things deferred during the deploy-readiness pass that are non-blocking
but should be revisited.

## three_operator_structural test (currently `#[ignore]`d)

`tests/three_operator.rs` is gated behind `#[ignore]` because upstream
`network-shapley` v0.2 added a `DataInconsistency` check that requires
demands sharing a `type` cluster to agree on **every** property
(priority, traffic, multicast, receivers, ...). Our synthetic fixture
still trips it even after normalising priority + multicast + traffic.

To re-enable:

1. Run locally with `cargo test --test three_operator -- --ignored` to
   reproduce.
2. Either reshape the fixture so each `type` is fully uniform (likely
   means one demand per type), or look at upstream to confirm the exact
   set of required-uniform fields and fix the offending ones.
3. Drop the `#[ignore]` attribute.

## Focus-link ownership semantics

Link estimation uses `OR` ownership (a link is focus-owned if *either*
endpoint device belongs to the focus operator). This **matches the Python
reference** `network_linkestimate` (`retag_links` tags a link when
`Operator1 == focus OR Operator2 == focus`), so it is correct for
Python-parity. The retag then assigns a per-link pseudo-operator only on the
focus side(s); the non-focus side stays `"Others"`.

If the DZ Foundation later decides link value should require `AND` (both
endpoints belong to the focus operator), that is a *divergence from Python*
and would need to be made in the engine's `retag_links`
(`network-shapley-rs/src/link_estimate.rs`), not just the service.

## Smoke test against deployed service

`tests/smoke.sh` is meant to run against the deployed route URL.
After deploying, add a CI step that runs it against the live service:

```bash
./tests/smoke.sh "https://<deployed-route-host>"
```

## Detach the baseline store from the request handler

A synchronous `/shapley` cold solve that gets cut by the router timeout (HAProxy
30s → 504) runs to completion on its `spawn_blocking` thread but its result is
DISCARDED: the store step in `compute_and_store_baseline` lives in the handler
future, which axum drops on client disconnect. Consequence: user-triggered cold
baseline requests burn full-length doomed solves, and the frontend's
`202 warming` state can only heal via the 6-hourly precompute cron.

Fix: wrap the cold path's solve+store in `tokio::spawn` (detached from the
request future, mirroring the worker path's store at `worker.rs`) so a cut
solve still lands in the memory+S3 cache — making warming self-heal on the
first request instead of waiting for the cron.
