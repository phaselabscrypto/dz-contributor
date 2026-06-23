# Documentation

Architecture and operations documentation for DZ Contributor Rewards — a Next.js 16 frontend plus a Rust Shapley microservice presenting live DoubleZero network state, reward distribution, and what-if forecasting. For the project overview, route table, and quick start, see the [root README](../README.md).

## Reading order

| Doc | Read it for |
|---|---|
| [architecture.md](./architecture.md) | **Start here.** System diagram, layer tour (pages → hooks → API routes → Rust service), the three main request flows, the caching matrix, data ownership, method labels, and the security posture summary. |
| [data-sources.md](./data-sources.md) | Every upstream feed in detail — malbec, the economic hub, Foundation S3 snapshots and exports, the fees CSV, Jupiter prices, Solana/DZ-ledger RPC — with URLs, cadences, consuming routes, and failure semantics. |
| [shapley-pipeline.md](./shapley-pipeline.md) | The computation core: the input-builder priority chain, solver dispatch and the no-silent-fallback policy, method labels, the dev-only TS solver, the per-city canonical engine, the per-link retag method, and correctness pinning. |
| [shapley-service.md](./shapley-service.md) | Rust microservice internals: binary roles, fail-closed auth, endpoints and input limits, the async job lifecycle on Redis Streams, the keyspace contract, the S3 result cache, and the concurrency model. |
| [development.md](./development.md) | Local setup (frontend-only and full-stack), the scripts inventory, the test matrix, and repo conventions. |
| [operations.md](./operations.md) | Deployment (Vercel + platform-generic container), the full environment-variable reference for both sides, CI workflows, rate limiting, security headers, and queue admin tooling. |
| [adr/0001-async-compute-queue.md](./adr/0001-async-compute-queue.md) | Why long Shapley solves run as queued jobs on Redis Streams with an always-warm worker pool, and the delivery/cancel/idempotency contract that decision committed to. |

## Conventions

- Code is referenced by file path (e.g. `lib/utils/shapley-remote.ts`), never line numbers — paths stay greppable as the code moves.
- Diagrams are [Mermaid](https://mermaid.js.org/) and render natively on GitHub.
- Where a source comment and the shipped code disagree, these docs document the **code** and call out the stale comment.
