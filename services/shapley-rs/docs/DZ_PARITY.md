# DoubleZero parity — source-of-truth mapping

This service's reward computation must match DoubleZero's
`contributor-rewards` pipeline. This doc pins the reference and maps every
piece of our code to the exact DZ source it mirrors, so a future change can be
checked against DZ line-by-line and we **never diverge again**.

## Pinned reference

| Thing | Version |
|---|---|
| DZ orchestration | `doublezerofoundation/doublezero-offchain` tag **`contributor-rewards/v0.5.3`** |
| DZ LP engine | `doublezerofoundation/network-shapley-rs` **v0.5.0** |
| Our LP engine (fork) | `phaselabscrypto/network-shapley-rs` rev **`c9fc7d1`** (`services/shapley-rs/Cargo.toml`) — `src/` verified byte-identical to the rev we build |
| IBRL demand priority | **`0.0`** (the epoch-149 value; DZ PR #369 raised it to 20.0 *after* epoch 149 — re-pinning epochs means re-verifying, not a drive-by bump) |
| Tuning | `operator_uptime=0.98`, `contiguity_bonus=5.0`, `demand_multiplier=1.0` |

## The method (what we replicate)

For an identical canonical input, our per-operator reward **proportions** equal
DZ's, computed as **per-source-city exact Shapley + leader-schedule
stake-weighted aggregation**:

1. **City weights** = `city.total_stake_proxy / Σ total_stake_proxy`, where
   `total_stake_proxy` = sum of Solana leader-schedule slot counts for that
   city's validators (a stake proxy, *not* lamports; metro price does **not**
   weight aggregation — it rides the Shred demand `priority`). Uniform `1/n`
   only when the global total is 0.
2. **Group** demands by source city (`demand.start`).
3. **Per city**, run the engine's **exact** `compute()` (full `2^n` coalition
   enumeration) — **no Monte-Carlo sampling on the reward path**. `rayon`-parallel.
4. **Aggregate**: `operator_value[op] += Σ_city (weight[city] · value[op,city])`;
   skip zero-weight cities.
5. **Proportion** = `value / Σ value`, **raw** (may be negative or >1 — clamped
   only at on-chain reward-leaf time, never in the share itself).

## Code ↔ DZ source

| Our code | DZ source (`contributor-rewards/v0.5.3`) |
|---|---|
| `lib/utils/canonical-input-builder.ts` `buildCityStats` (validators + `stakeProxy`) | `ingestor/demand.rs::build_city_stats` (`:119-283`, stake at `:151-181`) |
| `lib/utils/canonical-input-builder.ts` `buildDemands` (IBRL + Shred) | `ingestor/demand.rs::generate` (`:286-353`) |
| `lib/utils/canonical-input-builder.ts` `calculateCityWeights` | `calculator/util.rs::calculate_city_weights` (`:19-36`) |
| `ShapleyInput.city_weights` (TS) / `ShapleyInputIn.city_weights` (Rust) | `calculator/input.rs::ShapleyInputs.city_weights` |
| `routes.rs::compute_per_city` — group by `demand.start`, per-city exact `compute()`, rayon | `calculator/shapley/evaluator.rs::compute_shapley_values` (`:46-114`) |
| `routes.rs::aggregate_per_city` — `value*weight`, skip zero-weight, `share=value/Σ` raw | `calculator/shapley/aggregator.rs::aggregate_shapley_outputs` (`:16-67`) |
| engine `compute()` exactness | `network-shapley-rs` `src/shapley.rs::compute` (exact `2^n`) |
| reward-leaf conversion (parity test only) | `calculator/proof.rs::ShapleyOutputStorage::new` (`:25-74`) — `floor(clamp(p,0,1)·1e9)`, remainder → `rewards[0]`, total `1_000_000_000` |

## Why `build_input`'s commodity retag is still DZ-faithful

Our `routes.rs::build_input` retags each demand's `type` by
`(start, multicast, priority)` (it was added for the old monolithic path). DZ's
per-city path instead passes raw `kind` 1 (IBRL) / 2 (Shred). These are
**equivalent** because the engine's `consolidate_demand`
(`network-shapley-rs/src/consolidation.rs:72-141`) re-derives the LP commodity
structure from scratch regardless of the incoming type ids — **one commodity per
multicast row, one per unicast priority class**. So a city solved via
`build_input` produces a byte-identical LP to DZ feeding raw kinds. (The
epoch-149 leaf-parity test is the empirical proof.)

## Guardrail test

`services/shapley-rs/tests/parity_epoch149.rs` (gated `#[ignore]`, skips if the
fixture is absent):

- **Primary (authoritative):** our aggregated proportions → DZ `proof.rs` leaf
  conversion → assert the `unit_share` vector **exactly equals** DZ's **on-chain
  `RewardShare`s** for epoch 149 (integer equality).
- **Secondary (optional cross-check):** raw `value`/`proportion` within `1e-6`
  vs a locally-run DZ `aggregate_shapley_outputs` reference, when present.

Regenerate the fixture with `scripts/gen-epoch149-parity-fixture.ts` (needs
`DZ_LEDGER_RPC_URL`); see that script's header.

## Intentional deviations (documented, not divergences)

- **Reuse granularity:** what-if reuse is at **source-city** granularity
  (`routes.rs::reusable_city_values`), not coalition bitmasks. The engine's
  *exact* `compute()` never exposes a coalition cache (that was sampling-only),
  and DZ has no coalition reuse either. Result-identical; pure performance.
- **`hash_input` includes `city_weights`:** so a different weight vector keys a
  different cached aggregate rather than silently serving a stale one (issue
  #19). Weights are epoch-stable, so this never fragments the cache in practice.
- **`/link-estimate` is a faithful port of the Python `network_linkestimate`**
  (retag each focus link as a pseudo-operator → one exact 2^n coalition Shapley),
  verified against the Python reference in the engine crate
  (`tests/link_estimate_test.rs`). It is **single-shot over the whole demand set**,
  matching `network_linkestimate.py` — NOT the per-city + stake-weighted reward
  methodology used by `/shapley` and `/simulate` (the Python reference does not
  decompose link value per city either). Link ownership is OR semantics (matches
  Python). Capped at 20 link-players (mirrors Python's `n_ops < 21`).
