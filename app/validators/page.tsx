"use client";

import { Suspense, useMemo, useState } from "react";
import { Search, X, ChevronDown, ChevronUp } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import {
  EmptyState,
  ErrorState,
  SectionSkeleton,
  StatRowSkeleton,
} from "@/components/ui/states";
import { EarningsEstimate } from "@/components/validators/earnings-estimate";
import { ValidatorRewards } from "@/components/validators/validator-rewards";
import { usePublishers } from "@/lib/hooks/use-publishers";
import { useFees } from "@/lib/hooks/use-fees";
import { useLiveTopology } from "@/lib/hooks/use-live";
import { useEpochRate } from "@/lib/hooks/use-epoch-rate";
import { useValidatorStake } from "@/lib/hooks/use-validator-stake";
import { parseAsString, useQueryState } from "@/lib/hooks/use-url-state";
import {
  LAMPORTS_PER_SOL,
  getContributorDisplayName,
} from "@/lib/constants/config";
import { formatNumber } from "@/lib/utils/format";
import { validatePubkey } from "@/lib/utils/pubkey";
import {
  computeValidatorRewards,
  sumEligibleStakeLamports,
} from "@/lib/utils/reward-estimator";

/**
 * Below this length a failed query is a name or metro search, not a botched
 * pubkey, so no base58 hint fires. A pubkey is 32 characters at minimum, so
 * typing "gal" toward "Galaxy" stays quiet.
 */
const PUBKEY_ATTEMPT_MIN_LEN = 32;


function ValidatorsInner() {
  const {
    data: publishers,
    isLoading: pubLoading,
    error: pubError,
    mutate,
  } = usePublishers();
  const { data: feeHistory, isLoading: feeLoading, error: feesError } =
    useFees();
  const { data: topology } = useLiveTopology();
  const epochs = useEpochRate();

  // One query for the page. It drives the estimate and the table, which is why
  // it lives here rather than inside either one.
  const [query, setQuery] = useQueryState(
    "q",
    parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
  );
  const trimmed = query.trim();
  const parsed = validatePubkey(trimmed);
  const resolving = parsed.ok;
  const looksLikePubkeyAttempt =
    !parsed.ok && trimmed.length >= PUBKEY_ATTEMPT_MIN_LEN;

  const {
    data: stake,
    error: stakeError,
    isLoading: stakeLoading,
    mutate: mutateStake,
  } = useValidatorStake(resolving ? parsed.pubkey : null);

  // Collapsed once a specific validator is on screen, so the network-wide
  // numbers stop competing with the answer.
  const [networkOpen, setNetworkOpen] = useState(false);
  const showNetwork = !resolving || networkOpen;

  // Taken from the feed rather than hardcoded, so it always resolves and
  // never goes stale as validators join or leave.
  const examplePubkey = publishers?.publishers[0]?.vote_pubkey ?? null;

  // Rows sit below the estimate, and the table is long, so a click from deep
  // in the list has to bring the answer back into view.
  const selectValidator = (votePubkey: string) => {
    setQuery(votePubkey);
    setNetworkOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const deviceToContrib = useMemo(() => {
    const m = new Map<string, string>();
    if (topology) {
      for (const d of topology.devices) {
        if (d.code) m.set(d.code, d.contributorCode);
      }
    }
    return m;
  }, [topology]);

  const rewards = useMemo(() => {
    if (!publishers) return null;
    // Fees in SOL. Fall back to 0, never lamports, which would inflate the
    // pool by 1e9x.
    const avgFeeSol = feeHistory?.averageFeeSol ?? 0;
    return computeValidatorRewards(
      publishers,
      avgFeeSol,
      epochs,
      deviceToContrib,
    );
  }, [publishers, feeHistory, epochs, deviceToContrib]);

  const publisher = useMemo(() => {
    if (!publishers || !stake) return null;
    return (
      publishers.publishers.find(
        (p) =>
          p.vote_pubkey === stake.votePubkey ||
          p.node_pubkey === stake.nodePubkey,
      ) ?? null
    );
  }, [publishers, stake]);

  // Two failure modes: the request fails, or a 200 carries a null average.
  // Either way the SOL figures must not render as 0, which is
  // indistinguishable from a genuinely unstaked validator. A request still in
  // flight is neither, so it shows the skeleton below rather than this banner.
  const averageFeeSol = feeHistory?.averageFeeSol ?? null;
  const feesUnavailable =
    Boolean(feesError) || (!feeLoading && averageFeeSol === null);
  const contributorCode = publisher
    ? deviceToContrib.get(publisher.dz_device_code)
    : undefined;

  return (
    <>
      <PageHeader
        title="Validators"
        description="Paste any Solana vote account to estimate its earnings, or browse the validators connected to DoubleZero."
      />
      <div className="flex-1 px-4 py-4 sm:px-6 sm:py-6 space-y-5">
        <div className="space-y-1.5">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-cream-30" />
            <input
              type="text"
              aria-label="Paste a vote account, or search validators by name or metro"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Paste a vote account, or search by name or metro"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              aria-invalid={looksLikePubkeyAttempt}
              className="w-full bg-cream-5 border border-cream-8 pl-10 pr-10 py-2.5 text-sm font-mono text-cream placeholder:text-cream-30 placeholder:font-sans focus:outline-none focus:border-cream-20 transition-colors"
            />
            {query.length > 0 && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-cream-30 hover:text-cream"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {!resolving && (
            <p className="text-xs text-cream-30 font-mono">
              A vote account is 43 or 44 base58 characters.
              {examplePubkey && (
                <>
                  {" Try "}
                  <button
                    type="button"
                    onClick={() => setQuery(examplePubkey)}
                    className="underline decoration-dotted hover:text-cream-60"
                  >
                    {examplePubkey.slice(0, 8)}…{examplePubkey.slice(-6)}
                  </button>
                </>
              )}
            </p>
          )}
        </div>

        {pubError ? (
          <ErrorState
            title="Couldn't load publishers"
            message="The DoubleZero publisher feed did not respond."
            onRetry={() => mutate()}
          />
        ) : (
          <>
            {looksLikePubkeyAttempt && (
              <p
                role="alert"
                className="bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300"
              >
                {pubkeyHint(parsed)}
              </p>
            )}

            {resolving && (
              <div className="border border-border bg-surface p-4">
                {feesUnavailable && (
                  <p className="mb-3 bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300">
                    Couldn&apos;t load fee history, so the SOL figures are
                    hidden. Showing them as 0 would understate the estimate.
                  </p>
                )}
                {stakeError ? (
                  <StakeErrorState
                    status={stakeError.status}
                    pubkey={parsed.pubkey}
                    onRetry={() => mutateStake()}
                  />
                ) : stakeLoading || feeLoading || !stake || !publishers ? (
                  <div className="space-y-4">
                    <SectionSkeleton />
                    <StatRowSkeleton />
                  </div>
                ) : (
                  <EarningsEstimate
                    stake={stake}
                    publisher={publisher}
                    eligibleStakeLamports={sumEligibleStakeLamports(publishers)}
                    averageFeeSol={feesUnavailable ? null : averageFeeSol}
                    epochs={epochs}
                    contributorCode={contributorCode}
                    contributorName={
                      contributorCode
                        ? getContributorDisplayName(contributorCode)
                        : undefined
                    }
                  />
                )}
              </div>
            )}

            {resolving && rewards && (
              <button
                type="button"
                onClick={() => setNetworkOpen((v) => !v)}
                className="flex w-full items-center justify-between border-t border-border pt-4 text-xs font-mono text-cream-30 hover:text-cream-60"
              >
                <span>
                  {formatNumber(rewards.publishingValidatorCount)} connected
                  validators ·{" "}
                  {formatNumber(
                    rewards.totalPublishingStake / LAMPORTS_PER_SOL,
                    0,
                  )}{" "}
                  SOL eligible stake
                </span>
                <span className="flex items-center gap-1">
                  {networkOpen ? "hide" : "show all"}
                  {networkOpen ? (
                    <ChevronUp className="size-3.5" />
                  ) : (
                    <ChevronDown className="size-3.5" />
                  )}
                </span>
              </button>
            )}

            {showNetwork && (
              <ValidatorRewards
                rewards={rewards}
                isLoading={pubLoading || feeLoading}
                search={trimmed}
                onSelect={selectValidator}
                suppressEmptyMessage={resolving}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

function pubkeyHint(parsed: ReturnType<typeof validatePubkey>): string {
  if (parsed.ok) return "";
  switch (parsed.reason) {
    case "excluded-char":
      return "Base58 does not use the characters 0, O, I, or l. Check for a typo.";
    case "too-short":
    case "too-long":
      return "That looks like a pubkey but it is the wrong length. A vote account is 43 or 44 characters.";
    default:
      return "That is not a valid pubkey. A Solana vote account is 32 bytes encoded as base58.";
  }
}

function StakeErrorState({
  status,
  pubkey,
  onRetry,
}: {
  status: number;
  pubkey: string;
  onRetry: () => void;
}) {
  if (status === 404) {
    return (
      <EmptyState
        title="No vote account found"
        message="This pubkey is valid base58 but Solana does not report it as a vote account for the current epoch. Check that you pasted the vote account and not the node identity or a stake account."
        action={
          <a
            href={`https://explorer.solana.com/address/${pubkey}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-mono uppercase tracking-[0.12em] border border-cream-15 hover:border-cream-30 hover:bg-cream-8 px-3 py-1.5 transition-colors"
          >
            View on Solana Explorer
          </a>
        }
      />
    );
  }
  return (
    <ErrorState
      title={status === 429 ? "Too many lookups" : "Couldn't look up stake"}
      message={
        status === 429
          ? "The stake lookup is rate limited. Wait a minute and try again."
          : "The Solana RPC did not respond."
      }
      onRetry={onRetry}
    />
  );
}

export default function ValidatorsPage() {
  return (
    <Suspense fallback={null}>
      <ValidatorsInner />
    </Suspense>
  );
}
