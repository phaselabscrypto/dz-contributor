import { PageHeader } from "@/components/ui/page-header";
import Link from "next/link";
import { ExternalLink } from "lucide-react";

export const metadata = {
  title: "Methodology — DZ CONTRIBUTOR Rewards",
  description:
    "Every formula and data source behind the DZ contributor rewards tool.",
};

export default function MethodologyPage() {
  return (
    <>
      <PageHeader
        title="Methodology"
        description="Every formula, every data source, every assumption — auditable end to end."
      />
      <div className="flex-1 px-4 py-4 sm:px-6 sm:py-6 max-w-3xl mx-auto w-full">
        <div className="space-y-8 text-sm leading-relaxed">
          <Section title="Data sources">
            <p>
              The site stitches three live sources plus a snapshot archive.
              Every page that displays a derived number can be traced to one of
              these.
            </p>
            <SourceTable
              rows={[
                {
                  name: "malbeclabs/topology",
                  url: "https://data.malbeclabs.com/api/topology",
                  use: "Devices, links, validators, metros (live)",
                  cadence: "Polled every 60s",
                },
                {
                  name: "malbeclabs/status",
                  url: "https://data.malbeclabs.com/api/status",
                  use: "Link health, active issues, top-utilised paths",
                  cadence: "Polled every 60s",
                },
                {
                  name: "malbeclabs/stats",
                  url: "https://data.malbeclabs.com/api/stats",
                  use: "Validators-on-DZ count, stake share, total bandwidth",
                  cadence: "Polled every 60s",
                },
                {
                  name: "dz/economic-hub",
                  url: "https://doublezero.xyz/api/economic-hub",
                  use: "All-time 2Z distributed, debt, burn, per-contributor reward %",
                  cadence: "Polled every 5 min",
                },
                {
                  name: "DZ contributor-rewards snapshots",
                  url: "https://doublezero-contributor-rewards-mn-beta-snapshots.s3.us-east-1.amazonaws.com/",
                  use: "Per-epoch S3 snapshots used by the simulator",
                  cadence: "Per-epoch, immutable",
                },
                {
                  name: "DZ fees CSV",
                  url: "https://github.com/doublezerofoundation/fees",
                  use: "Historical Solana epoch fee totals (859–938)",
                  cadence: "Frozen — paused at 939",
                },
                {
                  name: "Jupiter price API",
                  url: "https://jup.ag",
                  use: "Live 2Z and SOL USD spot prices",
                  cadence: "Polled every 60s",
                },
              ]}
            />
          </Section>

          <Section title="Reward share (canonical)">
            <p>
              Every contributor&apos;s &ldquo;reward share&rdquo; on{" "}
              <Link href="/economics" className="underline decoration-dotted hover:text-foreground">
                /economics
              </Link>{" "}
              and{" "}
              <Link href="/contributors" className="underline decoration-dotted hover:text-foreground">
                /contributors
              </Link>{" "}
              comes directly from{" "}
              <ExtLink href="https://doublezero.xyz/api/economic-hub">
                doublezero.xyz/api/economic-hub
              </ExtLink>
              &apos;s <code>reward_percentage</code>. We do not recompute it
              client-side. This is the Foundation-published all-time share
              across the {`{epoch list}`} epochs distributed to date.
            </p>
            <Formula>
              earned_2Z(operator) = (reward_percentage / 100) ×
              total_distributed_2Z
            </Formula>
            <p>
              <code>reward_percentage</code> is{" "}
              <code>Σ paid_to_operator / Σ paid_total</code> across all
              distributed epochs — confirmed by DZ Foundation 2026-05-12.
              Not pool-size-weighted; a raw share of cumulative payout.
            </p>
          </Section>

          <Section title="Reward share (Shapley simulator)">
            <p>
              The{" "}
              <Link href="/simulate" className="underline decoration-dotted hover:text-foreground">
                Forecast
              </Link>{" "}
              tool runs a multi-commodity flow LP per coalition over the
              snapshot inputs, returning per-operator marginal contribution
              normalised to a share. When the Rust microservice is configured,
              we delegate to{" "}
              <ExtLink href="https://github.com/doublezerofoundation/network-shapley-rs">
                network-shapley-rs
              </ExtLink>{" "}
              for bit-comparable Foundation output. Otherwise the in-process
              TS solver is used as a directional fallback.
            </p>
            <p>
              Input tables (devices, private_links, public_links, demands)
              are built by a TypeScript port of Foundation&apos;s{" "}
              <code>build_shapley_inputs.py</code> reference, verified
              row-for-row identical to that reference on mainnet epoch 149.
              The reference is itself verified byte-for-byte against the
              upstream{" "}
              <ExtLink href="https://github.com/doublezerofoundation/doublezero-offchain/tree/main/crates/contributor-rewards">
                doublezero-offchain contributor-rewards
              </ExtLink>{" "}
              v0.5.3 Rust binary. Method label{" "}
              <code>canonical-snapshot</code> in the API response indicates
              the canonical path is active.
            </p>
            <Formula>
              {`coalition_value(S) = max Σ demand_satisfied(d) − contiguity_penalty
                       subject to per-link capacity, uptime, multicast rules
shapley(op) = Σ_S |S|!·(n−|S|−1)!/n! · [v(S∪{op}) − v(S)]
share(op)   = shapley(op) / Σ_op shapley(op)`}
            </Formula>
          </Section>

          <Section title="Latest-epoch Shapley anchor">
            <p>
              <code>GET /api/shapley/baseline</code> returns the
              Shapley values for the <em>latest completed epoch</em> (DZ-current
              methodology), served from the shared per-epoch cache and kept warm
              by the precompute cron — not an on-demand live-topology solve.
              Surfaced on{" "}
              <Link href="/economics" className="underline decoration-dotted hover:text-foreground">
                /economics
              </Link>{" "}
              under &ldquo;Latest-epoch Shapley anchor&rdquo;.
            </p>
            <p>
              Inputs come from the canonical TS builder when the historical
              S3 snapshot path is used. Public-link latencies are p95 over
              the epoch window across all non-RIPE Atlas internet latency
              providers (averaged per city pair). The public internet is
              treated as infinite-capacity per DZ Foundation Q16 — only
              private links have bandwidth constraints.
            </p>
            <p>
              Result is cached for 5 minutes (LP solve cost). Method label
              in the response is always{" "}
              <code>lp-multi-commodity-flow-rs</code> in production; if you
              see <code>local-ts-heuristic-DEV-ONLY</code> the deployment
              is missing <code>SHAPLEY_SERVICE_URL</code> and the result
              is not canonical.
            </p>
          </Section>

          <Section title="Projected 2Z payout">
            <p>
              On{" "}
              <Link href="/contributors" className="underline decoration-dotted hover:text-foreground">
                /contributors/[code]
              </Link>{" "}
              we project a forward 2Z payout per epoch. The pool is 45% of
              total fee revenue per the 45/45/10 split.
            </p>
            <Formula>
              {`per_epoch_2Z = current_share × average_2Z_per_epoch × 0.45
per_year_2Z  = per_epoch_2Z × 144`}
            </Formula>
            <p>
              <code>average_2Z_per_epoch</code> is the mean of historical fee
              CSV totals. This is a directional projection — the validator-
              paid fee feed is paused, so forward numbers should be read as
              &ldquo;at historical rates,&rdquo; not a rate card.
            </p>
          </Section>

          <Section title="Validator pool">
            <p>
              On{" "}
              <Link href="/validators" className="underline decoration-dotted hover:text-foreground">
                /validators
              </Link>{" "}
              we project SOL share of the 45% validator pool, stake-weighted
              across eligible publishers. Per DZ Foundation Q12, eligibility
              requires <code>publishing_leader_shreds = true</code> AND{" "}
              <code>publishing_retransmitted = false</code>. Anyone failing
              either condition receives zero. The pool is split 65/35 between
              validators and their clients respectively — the validator only
              keeps 65% of their stake-weighted share.
            </p>
            <Formula>
              {`validator_pool_per_epoch = average_fee_per_epoch_SOL × 0.45
operator_share           = activated_stake / Σ eligible_stake
validator_take_per_epoch = operator_share × validator_pool_per_epoch × 0.65`}
            </Formula>
            <p>
              <code>multicast_connected</code> is shown as a quality signal
              but is not weighted into the projection — Foundation Q12
              confirms eligibility is binary on shreds/retransmit, not a
              multicast multiplier. Publisher set membership is sourced
              from DZ Foundation&apos;s canonical{" "}
              <ExtLink href="https://doublezero-foundation-public.s3.us-east-2.amazonaws.com/exports/mulitcast_validators/latest.json">
                multicast_validators/latest.json
              </ExtLink>{" "}
              feed, enriched with malbec&apos;s publisher-check where it
              adds richer fields (retransmit flag, client version,
              validator name).
            </p>
          </Section>

          <Section title="Link Rewards">
            <p>
              <Link href="/link-value" className="underline decoration-dotted hover:text-foreground">
                /link-value
              </Link>{" "}
              shows CANONICAL per-link values only — a faithful port of
              DZ&apos;s <code>network_linkestimate</code>: each focus link is
              retagged as its own pseudo-operator and an exact coalition
              Shapley value is solved over the epoch&apos;s full demand set.
              Results are precomputed per epoch (cron sweep) and served from
              S3; uncached pairs run as a background job with live progress.
              There is no fallback estimator: if the canonical solve is
              unavailable the page says so and shows no values.
            </p>
            <Formula>
              {`link_value(L) = shapley_L over players {each focus link, "Others"}
share(L)      = max(link_value(L), 0) / Σ max(link_value(·), 0)`}
            </Formula>
          </Section>

          <Section title="Per-metro demand">
            <p>
              <Link href="/network" className="underline decoration-dotted hover:text-foreground">
                /network
              </Link>
              &apos;s metro-demand panel aggregates live topology by metro:
              inbound/outbound bps from links, validator count + stake from
              devices, and presence of multiple contributors as a redundancy
              signal.
            </p>
            <Formula>
              {`metro_inbound_bps   = Σ links where side ∈ metro: link.in_bps
metro_outbound_bps  = Σ links where side ∈ metro: link.out_bps
metro_capacity_bps  = Σ links where side ∈ metro: link.bandwidth_bps
metro_utilisation   = max(in, out) / capacity`}
            </Formula>
          </Section>

          <Section title="Reward history (per-epoch)">
            <p>
              The history strip on{" "}
              <Link href="/economics" className="underline decoration-dotted hover:text-foreground">
                /economics
              </Link>{" "}
              and{" "}
              <Link href="/contributors" className="underline decoration-dotted hover:text-foreground">
                /contributors/[code]
              </Link>{" "}
              currently estimates per-epoch payout by spreading the
              all-time total across distributed epochs.
            </p>
            <Formula>
              avg_per_epoch_2Z = total_distributed_2Z / |distributed_epochs|
            </Formula>
            <p>
              When the Foundation publishes a real per-epoch payout feed
              (Question #9), the chart swaps to actual per-contributor
              traces with no UI change.
            </p>
          </Section>

          <Section title="On-chain readers">
            <p>
              <code>/api/onchain/topology</code> and{" "}
              <code>/api/onchain/rewards</code> are wired and gated behind{" "}
              <code>ONCHAIN_ENABLED</code>. They return 503 with a stable
              shape until <code>DZ_REGISTRY_PROGRAM_ID</code> /{" "}
              <code>DZ_REWARDS_PROGRAM_ID</code> + the Foundation IDL are
              configured. Once enabled, the same endpoints return decoded
              account data and the malbec HTTP feeds become a fallback.
            </p>
          </Section>

          <Section title="Service health">
            <p>
              <code>GET /api/health</code> probes every upstream and the
              Rust microservice in parallel and reports overall status,
              per-source latency, and HTTP status codes. The sidebar pulse
              reads from this aggregate.
            </p>
          </Section>

          <Section title="Resolved methodology questions">
            <p>
              Confirmed by DZ Foundation 2026-05-12:
            </p>
            <ul className="list-disc list-inside space-y-1 text-cream-60">
              <li>
                <code>reward_percentage</code> = <code>Σ paid / Σ pool</code>
                {" "}— raw share of cumulative payout, not pool-weighted.
              </li>
              <li>
                Validator reward = <code>stake_share × 45% pool × 0.65</code>.
                Eligibility binary on publishing shreds AND not publishing
                retransmits. No multicast multiplier.
              </li>
              <li>
                Public-internet capacity is infinite — only private links
                have bandwidth constraints.
              </li>
              <li>
                New-city scenarios: users supply their own assumptions
                (validator count, traders, etc.) via the demand editor in{" "}
                <Link href="/simulate" className="underline decoration-dotted hover:text-foreground">
                  /simulate
                </Link>.
              </li>
              <li>
                Canonical input tables: TS port of{" "}
                <code>build_shapley_inputs.py</code> verified row-for-row
                identical on epoch 149.
              </li>
            </ul>
            <p className="mt-4">Still open:</p>
            <ul className="list-disc list-inside space-y-1 text-cream-60">
              <li>
                Per-epoch, per-contributor and per-validator payout history
                feed (no canonical feed exists per Q9 / Q10 / Q13 — currently
                a guess-and-check exercise via{" "}
                <ExtLink href="https://data.malbeclabs.com/dz/shreds/economics">
                  malbec/shreds/economics
                </ExtLink>
                ).
              </li>
              <li>
                Forward subscription revenue feed (token, denomination,
                cadence, public endpoint).
              </li>
              <li>
                On-chain reader activation: registry + rewards program IDs
                and the Foundation IDL for borsh decoding (Q6).
              </li>
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-base uppercase tracking-[0.08em] text-foreground">
        {title}
      </h2>
      <div className="space-y-3 text-cream-80">{children}</div>
    </section>
  );
}

function Formula({ children }: { children: React.ReactNode }) {
  return (
    <pre className="border border-border bg-surface px-3 py-2 font-mono text-xs text-cream-80 overflow-x-auto whitespace-pre">
      {children}
    </pre>
  );
}

function ExtLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-dotted hover:text-foreground inline-flex items-center gap-1"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

function SourceTable({
  rows,
}: {
  rows: Array<{ name: string; url: string; use: string; cadence: string }>;
}) {
  return (
    <div className="border border-border bg-surface overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
            <th className="px-3 py-2 text-left font-normal">Source</th>
            <th className="px-3 py-2 text-left font-normal">Use</th>
            <th className="px-3 py-2 text-left font-normal hidden sm:table-cell">
              Cadence
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.name}
              className="border-b border-border last:border-b-0 align-top"
            >
              <td className="px-3 py-2">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted hover:text-foreground font-mono"
                >
                  {r.name}
                </a>
              </td>
              <td className="px-3 py-2 text-cream-60">{r.use}</td>
              <td className="px-3 py-2 text-cream-40 hidden sm:table-cell">
                {r.cadence}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
