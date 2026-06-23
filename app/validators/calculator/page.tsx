"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { usePublishers } from "@/lib/hooks/use-publishers";
import { useFees } from "@/lib/hooks/use-fees";
import {
  LAMPORTS_PER_SOL,
  VALIDATOR_SHARE,
  VALIDATOR_TAKE_OF_POOL,
  EPOCHS_PER_MONTH,
  EPOCHS_PER_YEAR,
} from "@/lib/constants/config";
import { LoadingState, EmptyState, ErrorState } from "@/components/ui/states";
import { Search, ArrowRight } from "lucide-react";

function fmtSol(n: number, digits = 4): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export default function ValidatorCalculatorPage() {
  const { data: publishers, isLoading, error, mutate } = usePublishers();
  const { data: feeHistory } = useFees();
  const [pubkeyQuery, setPubkeyQuery] = useState("");
  const [overridePublishing, setOverridePublishing] = useState<boolean | null>(
    null,
  );
  const [overrideMulticast, setOverrideMulticast] = useState<boolean | null>(
    null,
  );

  const validator = useMemo(() => {
    if (!publishers || !pubkeyQuery.trim()) return null;
    const q = pubkeyQuery.trim().toLowerCase();
    return (
      publishers.publishers.find(
        (p) =>
          p.node_pubkey.toLowerCase() === q ||
          p.vote_pubkey.toLowerCase() === q ||
          p.validator_name.toLowerCase() === q,
      ) ?? null
    );
  }, [publishers, pubkeyQuery]);

  const matches = useMemo(() => {
    if (!publishers || !pubkeyQuery.trim() || validator) return [];
    const q = pubkeyQuery.trim().toLowerCase();
    // Substring match on validator_name only (the human-readable field).
    // Pubkey substring matching causes coincidence collisions — e.g.
    // typing "gojira" matches random base58 fragments in unrelated
    // node_pubkeys. For pubkey lookups, require ≥8 chars and match by
    // prefix only — that yields the real intent without false hits.
    return publishers.publishers
      .filter((p) => {
        const name = (p.validator_name || "").toLowerCase();
        if (name && name.includes(q)) return true;
        if (q.length >= 8) {
          return (
            p.node_pubkey.toLowerCase().startsWith(q) ||
            p.vote_pubkey.toLowerCase().startsWith(q)
          );
        }
        return false;
      })
      .sort((a, b) => {
        // Named validators rank above "Unknown". Then by stake size desc.
        const aHasName = !!a.validator_name;
        const bHasName = !!b.validator_name;
        if (aHasName !== bHasName) return aHasName ? -1 : 1;
        return b.activated_stake - a.activated_stake;
      })
      .slice(0, 8);
  }, [publishers, pubkeyQuery, validator]);

  const avgFeeSol = feeHistory?.averageFeeSol ?? 0;
  const validatorPoolSol = avgFeeSol * VALIDATOR_SHARE;

  // Effective publishing/multicast flags accounting for overrides
  const isPublishing = overridePublishing ?? validator?.publishing_leader_shreds ?? false;

  // Recompute totalPublishingStake under the override scenario.
  // Eligibility: publishing leader shreds AND not publishing retransmits.
  const adjustedPublishingStake = useMemo(() => {
    if (!publishers) return 0;
    let total = 0;
    for (const p of publishers.publishers) {
      const isMe = validator && p.node_pubkey === validator.node_pubkey;
      const pub = isMe
        ? overridePublishing ?? p.publishing_leader_shreds
        : p.publishing_leader_shreds;
      // Retransmit publishing disqualifies — always honored, not overridden.
      if (pub && !p.publishing_retransmitted) total += p.activated_stake;
    }
    return total;
  }, [publishers, validator, overridePublishing]);

  // Per DZ Foundation: eligible = publishing leader shreds AND not publishing
  // retransmits. The validator-pool-take after stake weighting is 65% (the
  // other 35% goes to clients).
  const stakeShare =
    isPublishing && adjustedPublishingStake > 0 && validator
      ? validator.activated_stake / adjustedPublishingStake
      : 0;
  const projectedSolPerEpoch =
    stakeShare * validatorPoolSol * VALIDATOR_TAKE_OF_POOL;

  // Baseline (current state) for comparison
  const baselinePublishingStake = publishers
    ? publishers.publishers
        .filter(
          (p) => p.publishing_leader_shreds && !p.publishing_retransmitted,
        )
        .reduce((s, p) => s + p.activated_stake, 0)
    : 0;
  const baselineShare =
    validator &&
    validator.publishing_leader_shreds &&
    !validator.publishing_retransmitted &&
    baselinePublishingStake > 0
      ? validator.activated_stake / baselinePublishingStake
      : 0;
  const baselineSolPerEpoch =
    baselineShare * validatorPoolSol * VALIDATOR_TAKE_OF_POOL;

  const deltaSol = projectedSolPerEpoch - baselineSolPerEpoch;

  return (
    <>
      <PageHeader
        title="Validator earnings calculator"
        description="Paste a vote pubkey, node pubkey, or validator name. See projected SOL share and what flips if you start publishing leader shreds or join multicast."
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6 space-y-6 max-w-5xl">
        <Link
          href="/validators"
          className="inline-flex items-center text-sm text-cream-60 hover:text-cream-80 transition-colors"
        >
          ← All validators
        </Link>

        {/* Search */}
        <div className="border border-border bg-surface px-3 py-2 flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <input
            type="text"
            value={pubkeyQuery}
            onChange={(e) => {
              setPubkeyQuery(e.target.value);
              setOverridePublishing(null);
              setOverrideMulticast(null);
            }}
            placeholder="Vote pubkey, node pubkey, or validator name…"
            className="flex-1 bg-transparent text-sm font-mono outline-none placeholder:text-muted-foreground"
          />
        </div>

        {error ? (
          <ErrorState
            title="Couldn't load publishers"
            message={(error as Error).message}
            onRetry={() => mutate()}
          />
        ) : isLoading ? (
          <LoadingState label="Fetching publisher set" />
        ) : !pubkeyQuery.trim() ? (
          <EmptyState
            title="Search to begin"
            message="Enter any portion of a node pubkey, vote pubkey, or validator name above."
          />
        ) : !validator && matches.length === 0 ? (
          <EmptyState
            title="No match"
            message="No connected validator matches that input."
          />
        ) : !validator ? (
          <div className="border border-border bg-surface">
            <div className="border-b border-border px-4 py-2.5 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
              {matches.length} match{matches.length === 1 ? "" : "es"}
            </div>
            <div className="divide-y divide-border">
              {matches.map((m) => (
                <button
                  key={m.node_pubkey}
                  type="button"
                  onClick={() => setPubkeyQuery(m.node_pubkey)}
                  className="w-full px-4 py-3 flex items-center justify-between gap-3 text-sm hover:bg-surface-2/40 transition-colors text-left"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {m.validator_name || "Unknown"}
                    </div>
                    <div className="text-xs font-mono text-cream-30 truncate">
                      {m.node_pubkey}
                    </div>
                  </div>
                  <ArrowRight className="size-4 text-cream-30 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Identity */}
            <div className="border border-border bg-surface p-4 space-y-2">
              <div className="font-display text-xl">
                {validator.validator_name || "Unknown"}
              </div>
              <div className="text-xs font-mono text-cream-30 break-all">
                node {validator.node_pubkey}
              </div>
              <div className="text-xs font-mono text-cream-30 break-all">
                vote {validator.vote_pubkey}
              </div>
              <div className="flex flex-wrap gap-3 text-xs font-mono text-cream-60 pt-2">
                <span>
                  metro <span className="text-foreground uppercase">{validator.dz_metro_code}</span>
                </span>
                <span>
                  device <span className="text-foreground">{validator.dz_device_code}</span>
                </span>
                <span>
                  client <span className="text-foreground">{validator.validator_client}</span>
                </span>
                <span>
                  v <span className="text-foreground">{validator.validator_version}</span>
                </span>
              </div>
            </div>

            {/* Toggles */}
            <div className="border border-border bg-surface p-4 space-y-4">
              <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                What-if toggles
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                <ToggleField
                  label="Publishing leader shreds"
                  current={validator.publishing_leader_shreds}
                  override={overridePublishing}
                  onChange={setOverridePublishing}
                />
                <ToggleField
                  label="Multicast connected"
                  current={validator.multicast_connected}
                  override={overrideMulticast}
                  onChange={setOverrideMulticast}
                />
              </div>
              <p className="text-xs text-cream-30 font-mono leading-relaxed">
                Multicast is currently treated as a quality flag — DZ has not
                confirmed if it changes the SOL payout (Q12). The publishing
                toggle does affect projected SOL because non-publishing
                validators receive 0 from the validator pool.
              </p>
            </div>

            {/* Projection */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px border border-border bg-border">
              <Stat
                label="Stake share"
                value={
                  isPublishing
                    ? `${(stakeShare * 100).toFixed(3)}%`
                    : "0%"
                }
                sub={`of ${(adjustedPublishingStake / LAMPORTS_PER_SOL).toLocaleString(undefined, { maximumFractionDigits: 0 })} SOL publishing`}
              />
              <Stat
                label="Per epoch"
                value={`${fmtSol(projectedSolPerEpoch, 4)} SOL`}
                tone={
                  deltaSol > 0
                    ? "ok"
                    : deltaSol < 0
                    ? "warn"
                    : undefined
                }
                sub={
                  Math.abs(deltaSol) > 1e-6
                    ? `${deltaSol > 0 ? "+" : ""}${fmtSol(deltaSol, 4)} vs current`
                    : undefined
                }
              />
              <Stat
                label="Per month"
                value={`${fmtSol(projectedSolPerEpoch * EPOCHS_PER_MONTH, 2)} SOL`}
                sub={`${EPOCHS_PER_MONTH} epochs`}
              />
              <Stat
                label="Per year"
                value={`${fmtSol(projectedSolPerEpoch * EPOCHS_PER_YEAR, 2)} SOL`}
                sub={`${EPOCHS_PER_YEAR} epochs`}
              />
            </div>

            <p className="text-xs text-cream-30 font-mono leading-relaxed">
              Validator pool = 45% of historical fee revenue average ·
              {" "}{fmtSol(validatorPoolSol, 2)} SOL/epoch.
              Distributed pro-rata to eligible validators by activated stake.
              Eligibility: publishing leader shreds <em>and</em> not publishing
              retransmits. Validator&apos;s share of the pool is{" "}
              {(VALIDATOR_TAKE_OF_POOL * 100).toFixed(0)}% — the remaining{" "}
              {((1 - VALIDATOR_TAKE_OF_POOL) * 100).toFixed(0)}% goes to clients
              per the DZ revenue split.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function ToggleField({
  label,
  current,
  override,
  onChange,
}: {
  label: string;
  current: boolean;
  override: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const effective = override ?? current;
  return (
    <div className="flex items-center gap-3">
      <span className="text-cream-60">{label}</span>
      <div className="flex items-center gap-1 border border-border">
        <button
          type="button"
          onClick={() => onChange(false)}
          className={`px-2 py-0.5 text-xs font-mono transition-colors ${
            effective === false
              ? "bg-red-500/10 text-red-300"
              : "text-cream-30 hover:text-foreground"
          }`}
        >
          off
        </button>
        <button
          type="button"
          onClick={() => onChange(true)}
          className={`px-2 py-0.5 text-xs font-mono transition-colors ${
            effective === true
              ? "bg-emerald-500/10 text-emerald-300"
              : "text-cream-30 hover:text-foreground"
          }`}
        >
          on
        </button>
        {override !== null && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="px-2 py-0.5 text-xs font-mono text-cream-30 hover:text-foreground transition-colors"
          >
            ↺
          </button>
        )}
      </div>
      <span className="text-xs font-mono text-cream-30">
        current: {current ? "on" : "off"}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn";
}) {
  const cls =
    tone === "ok"
      ? "text-emerald-300"
      : tone === "warn"
      ? "text-amber-300"
      : "";
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className={`mt-1 text-xl font-mono tabular-nums ${cls}`}>{value}</div>
      {sub && (
        <div className="text-xs text-cream-30 font-mono mt-0.5">{sub}</div>
      )}
    </div>
  );
}
