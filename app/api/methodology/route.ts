import { NextResponse } from "next/server";
import {
  CONTRIBUTOR_SHARE,
  VALIDATOR_SHARE,
  BURN_RATE,
  EPOCHS_PER_MONTH,
  EPOCHS_PER_YEAR,
  SHAPLEY_PARAMS,
} from "@/lib/constants/config";

/**
 * GET /api/methodology
 *
 * Machine-readable manifest of every formula, constant, and data source
 * the site uses to compute the figures we display. Mirrors the prose in
 * /methodology so external auditors (DZ algorithm team in particular)
 * can spot-check our work programmatically.
 *
 * Stable contract: never remove a key, only add. Bump `version` on any
 * formula change so consumers can diff.
 */
export async function GET() {
  return NextResponse.json({
    version: "1.0.0",
    name: "dz-contributor",
    description:
      "DoubleZero contributor rewards simulator and analytics. " +
      "Pulls live state from malbeclabs and the on-chain economic hub, " +
      "runs a multi-commodity flow Shapley solver against snapshots, " +
      "and projects forward 2Z payouts.",
    sources: [
      {
        id: "malbec-topology",
        name: "malbeclabs/api/topology",
        url: "https://data.malbeclabs.com/api/topology",
        used_for: ["devices", "links", "validators", "metros", "contributors"],
        refresh_seconds: 60,
      },
      {
        id: "malbec-stats",
        name: "malbeclabs/api/stats",
        url: "https://data.malbeclabs.com/api/stats",
        used_for: ["validators-on-DZ", "stake share", "total bandwidth"],
        refresh_seconds: 60,
      },
      {
        id: "malbec-status",
        name: "malbeclabs/api/status",
        url: "https://data.malbeclabs.com/api/status",
        used_for: ["link health", "issues", "top-utilized links"],
        refresh_seconds: 60,
      },
      {
        id: "dz-economic-hub",
        name: "doublezero.xyz/api/economic-hub",
        url: "https://doublezero.xyz/api/economic-hub",
        used_for: [
          "total 2Z distributed",
          "outstanding 2Z debt",
          "burned 2Z",
          "all-time per-contributor reward share",
        ],
        refresh_seconds: 300,
      },
      {
        id: "dz-publishers",
        name: "malbeclabs/api/dz/publisher-check",
        url: "https://data.malbeclabs.com/api/dz/publisher-check",
        used_for: [
          "publishing validator list",
          "activated stake",
          "multicast connection",
          "leader-shred publication",
        ],
        refresh_seconds: 300,
      },
      {
        id: "dz-fees-csv",
        name: "doublezerofoundation/fees consolidated CSV",
        url: "https://raw.githubusercontent.com/doublezerofoundation/fees/main/fees_and_payments_consolidated.csv",
        used_for: ["historical per-validator fee revenue per Solana epoch"],
        notes:
          "Columns: dz_fee_lamports_<epoch> per validator + a `previous_fees` aggregate. " +
          "Live epoch range and per-epoch totals are derived from this CSV; see /api/fees for the parsed shape.",
      },
      {
        id: "snapshot-s3",
        name: "DZ snapshot S3 bucket",
        url_template:
          "https://doublezero-contributor-rewards-mn-beta-snapshots.s3.us-east-1.amazonaws.com/mn-epoch-{N}-snapshot.json",
        used_for: ["historical Shapley simulation per DZ epoch"],
      },
      {
        id: "shapley-rs",
        name: "network-shapley-rs",
        url: "https://github.com/doublezerofoundation/network-shapley-rs",
        used_for: ["canonical LP-based Shapley computation"],
      },
    ],
    constants: {
      revenue_split: {
        contributor_share: CONTRIBUTOR_SHARE,
        validator_share: VALIDATOR_SHARE,
        burn_rate: BURN_RATE,
        sum: CONTRIBUTOR_SHARE + VALIDATOR_SHARE + BURN_RATE,
      },
      epoch_cadence: {
        epochs_per_month_approx: EPOCHS_PER_MONTH,
        epochs_per_year_approx: EPOCHS_PER_YEAR,
        notes: "Solana epochs are ~2-3 days; rough averages.",
      },
      shapley: SHAPLEY_PARAMS,
    },
    formulas: {
      contributor_reward_per_epoch: {
        description:
          "Projected 2Z paid to contributor in a given epoch.",
        expression:
          "shapley_share(op) * pool_2Z_per_epoch * CONTRIBUTOR_SHARE",
        inputs: {
          shapley_share: "0-1 normalized output of the LP solver",
          pool_2Z_per_epoch:
            "average historical 2Z fee revenue, or live projection from /api/economics/projection",
          CONTRIBUTOR_SHARE: 0.45,
        },
      },
      validator_reward_per_epoch: {
        description:
          "Projected SOL kept by an eligible publishing validator in a given epoch.",
        expression:
          "(activated_stake_lamports / sum_eligible_stake) * pool_SOL_per_epoch * 0.65",
        notes:
          "Eligibility (Foundation Q12, confirmed 2026-05-12): publishing_leader_shreds=true AND publishing_retransmitted=false. Pool is split 65/35 between validator and client; this expression returns the validator's 65% take. Multicast connection is a quality flag, not a multiplier.",
      },
      coalition_value: {
        description: "Per-coalition LP objective function.",
        expression:
          "max sum_d demand_satisfied(d) - contiguity_penalty subject to per-link bandwidth, uptime, multicast",
        notes:
          "Implemented in network-shapley-rs. The TS fallback uses bandwidth-aware greedy demand packing.",
      },
      shapley_value: {
        description: "Marginal contribution of an operator across all coalitions.",
        expression:
          "shapley(op) = sum_S |S|!*(n-|S|-1)!/n! * [v(S union {op}) - v(S)]",
      },
      shapley_share: {
        description: "Operator's normalized share of the contributor pool.",
        expression: "share(op) = shapley(op) / sum_op shapley(op)",
      },
      link_value_estimate: {
        description:
          "Canonical per-link Shapley shown on /link-value — a faithful port of DZ's " +
          "network_linkestimate: each focus link is retagged as its own pseudo-operator " +
          "and an exact 2^n coalition Shapley is solved over the epoch's full demand " +
          "set. Precomputed per epoch (cron sweep) and served from S3; uncached pairs " +
          "run as a background job. There is NO fallback estimator — failures surface " +
          "as errors.",
        expression:
          "link_value(L) = shapley_L over players {each focus link, 'Others'}; " +
          "share(L) = max(link_value(L), 0) / sum max(link_value, 0)",
        components: {
          retag:
            "every focus-owned link pair gets a unique pseudo-operator; all other " +
            "operators collapse to 'Others'; on/off-ramps to 'Private'",
          cap: "20 link-players max (mirrors the reference's n_ops < 21 assert)",
          uptime:
            "operator_uptime forced to 1.0 (the per-link Uptime penalty still applies)",
        },
        notes:
          "Method label: retag-shapley-rs. Parity with network_linkestimate.py is " +
          "pinned by golden tests in the engine crate (value <= 0.01, share <= 1e-4).",
      },
      pool_projection: {
        description: "Forward 2Z pool projection from historical growth rate.",
        expression:
          "pool_per_epoch_n = pool_per_epoch_avg * (1 + growth_rate)^n",
        inputs: {
          growth_rate:
            "log(second_half_avg / first_half_avg) / (epochs_count / 2)",
          n: "epochs forward from latest distributed",
        },
        endpoint: "/api/economics/projection",
      },
    },
    endpoints: {
      live: ["/api/live/topology", "/api/live/stats", "/api/live/status", "/api/live/economic-hub"],
      shapley: ["/api/shapley", "/api/shapley/baseline", "/api/shapley/simulate", "/api/shapley/tracking"],
      analysis: ["/api/diff", "/api/economics/projection", "/api/link-value/jobs"],
      onchain_stubs: [
        "/api/onchain/topology",
        "/api/onchain/rewards",
        "/api/onchain/contributor-rewards",
        "/api/onchain/validators",
      ],
      meta: ["/api/health", "/api/methodology"],
    },
    generated_at: new Date().toISOString(),
  });
}
