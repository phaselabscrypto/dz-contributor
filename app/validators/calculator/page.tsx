"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";

import { PageHeader } from "@/components/ui/page-header";
import {
  EmptyState,
  ErrorState,
  SectionSkeleton,
  StatRowSkeleton,
} from "@/components/ui/states";
import {
  EarningsEstimate,
} from "@/components/validators/earnings-estimate";
import { VoteKeyForm } from "@/components/validators/vote-key-form";
import { useEpochRate } from "@/lib/hooks/use-epoch-rate";
import { useFees } from "@/lib/hooks/use-fees";
import { useLiveTopology } from "@/lib/hooks/use-live";
import { usePublishers } from "@/lib/hooks/use-publishers";
import { useValidatorStake } from "@/lib/hooks/use-validator-stake";
import { parseAsString, useQueryState } from "@/lib/hooks/use-url-state";
import { getContributorDisplayName } from "@/lib/constants/config";
import { shortenPubkey } from "@/lib/utils/format";
import { sumEligibleStakeLamports } from "@/lib/utils/reward-estimator";
import { validatePubkey } from "@/lib/utils/pubkey";

function CalculatorInner() {
  // `vote` rather than `q`: this field is not a query, and naming it in the URL
  // documents that node identities are not the expected input.
  const [vote, setVote] = useQueryState(
    "vote",
    parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
  );

  const {
    data: publishers,
    isLoading: publishersLoading,
    error: publishersError,
    mutate: mutatePublishers,
  } = usePublishers();
  const { data: feeHistory, error: feesError } = useFees();
  const { data: topology } = useLiveTopology();
  const epochs = useEpochRate();

  const validated = validatePubkey(vote);
  const {
    data: stake,
    error: stakeError,
    isLoading: stakeLoading,
    mutate: mutateStake,
  } = useValidatorStake(validated.ok ? validated.pubkey : null);

  // The publisher row for the resolved validator, if the feed has one. Matched
  // on either key, because the route resolves both and the feed stores both.
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

  // A pasted node identity that the feed knows: offer the vote account rather
  // than silently estimating from a key the user did not mean to give.
  const identityOnly = useMemo(() => {
    if (!publishers || stake || !validated.ok) return null;
    return (
      publishers.publishers.find((p) => p.node_pubkey === validated.pubkey) ??
      null
    );
  }, [publishers, stake, validated]);

  const eligibleStakeLamports = publishers
    ? sumEligibleStakeLamports(publishers)
    : 0;

  const contributorCode = publisher
    ? topology?.devices.find((d) => d.code === publisher.dz_device_code)
        ?.contributorCode
    : undefined;

  // Two failure modes, not one: the request can fail, and a 200 can carry a
  // null average. Either way the SOL figures must not render as 0, which is
  // indistinguishable from a genuinely unstaked validator.
  const averageFeeSol = feeHistory?.averageFeeSol ?? null;
  const feesUnavailable = Boolean(feesError) || averageFeeSol === null;

  // The eligible-stake sum is the denominator of every share, and there is no
  // honest fallback for it, so a dead publisher feed is a hard block.
  if (publishersError) {
    return (
      <Shell>
        <ErrorState
          title="Couldn't load publishers"
          message="The DoubleZero publisher feed did not respond."
          onRetry={() => mutatePublishers()}
        />
      </Shell>
    );
  }

  let body: React.ReactNode;

  if (!vote) {
    body = (
      <EmptyState
        title="Paste a vote account"
        message="Enter the vote account pubkey of any Solana validator. The estimate works whether or not the validator is on DoubleZero."
        action={
          <Link
            href="/validators"
            className="text-xs font-mono uppercase tracking-[0.12em] border border-cream-15 hover:border-cream-30 hover:bg-cream-8 px-3 py-1.5 transition-colors"
          >
            Browse validators instead
          </Link>
        }
      />
    );
  } else if (!validated.ok) {
    // The form renders the specific hint inline; nothing to add here.
    body = null;
  } else if (identityOnly) {
    body = (
      <EmptyState
        title="That is a node identity, not a vote account"
        message={`${identityOnly.validator_name || "This validator"} publishes from this identity. The estimate needs the vote account.`}
        action={
          <button
            type="button"
            onClick={() => setVote(identityOnly.vote_pubkey)}
            className="text-xs font-mono uppercase tracking-[0.12em] border border-cream-15 hover:border-cream-30 hover:bg-cream-8 px-3 py-1.5 transition-colors"
          >
            Use vote account {shortenPubkey(identityOnly.vote_pubkey)}
          </button>
        }
      />
    );
  } else if (stakeError) {
    body =
      stakeError.status === 404 ? (
        <EmptyState
          title="No vote account found"
          message="This pubkey is valid base58 but Solana does not report it as a vote account for the current epoch. Check that you pasted the vote account and not the node identity or a stake account."
          action={
            <a
              href={`https://explorer.solana.com/address/${validated.pubkey}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-mono uppercase tracking-[0.12em] border border-cream-15 hover:border-cream-30 hover:bg-cream-8 px-3 py-1.5 transition-colors"
            >
              View on Solana Explorer
            </a>
          }
        />
      ) : stakeError.status === 429 ? (
        <ErrorState
          title="Too many lookups"
          message="The stake lookup is rate limited. Wait a minute and try again."
          onRetry={() => mutateStake()}
        />
      ) : (
        <ErrorState
          title="Couldn't look up stake"
          message="The Solana RPC did not respond."
          onRetry={() => mutateStake()}
        />
      );
  } else if (stakeLoading || publishersLoading || !stake || !publishers) {
    body = (
      <div className="space-y-6">
        <SectionSkeleton />
        <StatRowSkeleton />
      </div>
    );
  } else {
    body = (
      <EarningsEstimate
        stake={stake}
        publisher={publisher}
        eligibleStakeLamports={eligibleStakeLamports}
        averageFeeSol={feesUnavailable ? null : averageFeeSol}
        epochs={epochs}
        feedEpoch={publishers.epoch ?? null}
        contributorCode={contributorCode}
        contributorName={
          contributorCode ? getContributorDisplayName(contributorCode) : undefined
        }
      />
    );
  }

  return (
    <Shell>
      <VoteKeyForm initial={vote} onSubmit={(next) => setVote(next)} />
      {feesUnavailable && (
        <p className="bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300">
          Couldn&apos;t load fee history. Stake share is still shown. The SOL
          figures are hidden until the fee feed recovers, because they would
          otherwise read as 0 SOL and understate the estimate.
        </p>
      )}
      {body}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader
        title="Validator earnings estimate"
        description="Paste the vote account of any Solana validator. The estimate uses activated stake from the chain, so it works whether or not the validator is on DoubleZero."
      />
      <div className="flex-1 px-4 py-4 sm:px-6 sm:py-6 space-y-6">
        <Link
          href="/validators"
          className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-[0.12em] text-cream-60 hover:text-cream"
        >
          ← All validators
        </Link>
        {children}
      </div>
    </>
  );
}

export default function ValidatorCalculatorPage() {
  return (
    <Suspense fallback={null}>
      <CalculatorInner />
    </Suspense>
  );
}
