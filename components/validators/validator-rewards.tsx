"use client";

import { useMemo } from "react";
import type { ValidatorRewardsSummary } from "@/lib/types/publisher";
import { useLocalStorageState } from "@/lib/hooks/use-local-storage";
import {
  makeSortStateValidator,
  type SortState,
} from "@/lib/utils/sort-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  formatSolFromSol,
  formatPercent,
  formatNumber,
  shortenPubkey,
} from "@/lib/utils/format";
import {
  LAMPORTS_PER_SOL,
  getContributorDisplayName,
  getContributorColor,
} from "@/lib/constants/config";
import Link from "next/link";
import { Loader2, ArrowUpDown, ArrowUp, ArrowDown, Download } from "lucide-react";
import { rowsToCsv, downloadCsv } from "@/lib/utils/csv";

type SortKey = "name" | "stake" | "share" | "slots" | "rewardEpoch" | "rewardMonth";
type SortDir = "asc" | "desc";

const SORT_KEYS: Record<SortKey, true> = {
  name: true,
  stake: true,
  share: true,
  slots: true,
  rewardEpoch: true,
  rewardMonth: true,
};
const DEFAULT_SORT: SortState<SortKey> = { key: "stake", dir: "desc" };
const validateSort = makeSortStateValidator(SORT_KEYS);

interface ValidatorRewardsProps {
  rewards: ValidatorRewardsSummary | null;
  isLoading: boolean;
  /** Current query, owned by the page since it also drives the estimate. */
  search: string;
  /** Row click. Fills the page search, which surfaces the estimate above. */
  onSelect: (votePubkey: string) => void;
  /** Silence the table's own "no matches" line when the page has already
   *  answered the query with an estimate panel above it. */
  suppressEmptyMessage?: boolean;
}

function StatusBadge({ publishing, backup }: { publishing: boolean; backup: boolean }) {
  if (publishing) {
    return (
      <Badge className="bg-green/10 text-green border-green/20 text-xs">
        Publishing
      </Badge>
    );
  }
  if (backup) {
    return (
      <Badge className="bg-amber/10 text-amber border-amber/20 text-xs">
        Backup
      </Badge>
    );
  }
  return (
    <Badge className="bg-cream-5 text-cream-40 border-cream-8 text-xs">
      Not Publishing
    </Badge>
  );
}

export function ValidatorRewards({
  rewards,
  isLoading,
  search,
  onSelect,
  suppressEmptyMessage = false,
}: ValidatorRewardsProps) {

  const [sortState, setSortState] = useLocalStorageState(
    "dz.validators.sort",
    DEFAULT_SORT,
    validateSort,
  );
  const sortKey = sortState.key;
  const sortDir = sortState.dir;

  const handleSort = (key: SortKey) => {
    setSortState((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  };

  const filtered = useMemo(() => {
    if (!rewards) return [];
    let list = rewards.validators;
    if (search.trim()) {
      const q = search.toLowerCase();
      // Name + metro use substring match (human-readable fields).
      // Pubkeys require ≥8 chars + prefix match to avoid coincidence
      // hits on random base58 fragments (e.g. typing "gojira" should
      // not match every pubkey that happens to contain "gojira").
      list = list.filter((v) => {
        const name = (v.validatorName || "").toLowerCase();
        if (name && name.includes(q)) return true;
        if (v.dzMetroCode.toLowerCase().includes(q)) return true;
        if (q.length >= 8) {
          return (
            v.nodePubkey.toLowerCase().startsWith(q) ||
            v.votePubkey.toLowerCase().startsWith(q)
          );
        }
        return false;
      });
    }
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = (a.validatorName || "").localeCompare(b.validatorName || "");
          break;
        case "stake":
          cmp = a.activatedStake - b.activatedStake;
          break;
        case "share":
          cmp = a.stakeSharePercent - b.stakeSharePercent;
          break;
        case "slots":
          cmp = a.leaderSlots - b.leaderSlots;
          break;
        case "rewardEpoch":
          cmp = a.projectedRewardPerEpochSol - b.projectedRewardPerEpochSol;
          break;
        case "rewardMonth":
          cmp = a.projectedRewardMonthlySol - b.projectedRewardMonthlySol;
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rewards, search, sortKey, sortDir]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-6 text-cream-30 animate-spin" />
          <p className="text-sm text-cream-40">Loading publisher data...</p>
        </div>
      </div>
    );
  }

  if (!rewards || rewards.validators.length === 0) {
    return (
      <Card className="bg-cream-5 border-cream-8">
        <CardContent className="py-8 text-center text-sm text-cream-40">
          No publisher data available for the current epoch.
        </CardContent>
      </Card>
    );
  }

  const avgReward =
    rewards.projectedValidatorPoolPerEpochSol /
    Math.max(rewards.publishingValidatorCount, 1);

  return (
    <div className="space-y-6">
      {/* Summary metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard
          label="Publishing validators"
          value={formatNumber(rewards.publishingValidatorCount)}
          note={`of ${formatNumber(rewards.validators.length)} connected`}
        />
        <MetricCard
          label="Publishing stake"
          value={`${formatSolFromSol(rewards.totalPublishingStake / LAMPORTS_PER_SOL, 0)} SOL`}
          note="Combined activated stake"
        />
        <MetricCard
          label="Validator pool / epoch"
          value={`${formatSolFromSol(rewards.projectedValidatorPoolPerEpochSol)} SOL`}
          note="45% of total fees (incl. validator clients)"
        />
        <MetricCard
          label="Avg reward / epoch"
          value={`${formatSolFromSol(avgReward, 4)} SOL`}
          note="Per publishing validator"
        />
      </div>

      {/* CSV export. The search lives on the page, above the estimate. */}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            const headers = [
              "Validator",
              "Vote pubkey",
              "Node pubkey",
              "Contributor",
              "Metro",
              "Activated stake (SOL)",
              "Stake share %",
              "Publishing leader shreds",
              "Multicast connected",
              "Backup",
              "Leader slots",
              "Total slots",
              "Client",
              "Version",
              "Projected SOL/epoch",
              "Projected SOL/month",
              "Projected SOL/year",
            ];
            const rows = filtered.map((v) => [
              v.validatorName || "Unknown",
              v.votePubkey,
              v.nodePubkey,
              v.contributorCode ?? "",
              v.dzMetroCode,
              (v.activatedStake / 1e9).toFixed(2),
              v.stakeSharePercent.toFixed(4),
              v.publishingLeaderShreds,
              v.multicastConnected,
              v.isBackup,
              v.leaderSlots,
              v.totalSlots,
              v.validatorClient,
              v.validatorVersion,
              v.projectedRewardPerEpochSol.toFixed(6),
              v.projectedRewardMonthlySol.toFixed(4),
              v.projectedRewardYearlySol.toFixed(4),
            ]);
            downloadCsv(
              `dz-validators-epoch${rewards.epoch}-${new Date().toISOString().slice(0, 10)}.csv`,
              rowsToCsv(headers, rows),
            );
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cream-8 bg-cream-5 hover:bg-cream-8 px-3 py-2.5 text-xs font-mono uppercase tracking-[0.12em] text-cream-60 hover:text-foreground transition-colors shrink-0"
        >
          <Download className="size-3.5" />
          <span className="hidden sm:inline">Export CSV</span>
        </button>
      </div>

      {/* Desktop: Table */}
      <div className="hidden md:block">
        <Card className="bg-cream-5 border-cream-8 overflow-hidden">
          <CardHeader>
            <CardTitle className="font-display text-sm tracking-wide text-cream">
              {formatNumber(rewards.publishingValidatorCount)} Publishers
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-cream-8 hover:bg-transparent">
                    <SortableHead label="Validator" sortKey="name" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                    <TableHead className="text-cream-40">Contributor</TableHead>
                    <TableHead className="text-cream-40">Metro</TableHead>
                    <SortableHead label="Stake (SOL)" sortKey="stake" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                    <SortableHead label="Share" sortKey="share" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                    <SortableHead label="Leader Slots" sortKey="slots" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                    <TableHead className="text-cream-40">Client</TableHead>
                    <TableHead className="text-cream-40">Quality</TableHead>
                    <SortableHead label="Est. / Epoch" sortKey="rewardEpoch" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                    <SortableHead label="Est. / Month" sortKey="rewardMonth" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((v) => (
                    <TableRow
                      key={v.nodePubkey}
                      onClick={() => onSelect(v.votePubkey)}
                      className={`border-cream-8 cursor-pointer hover:bg-cream-8 transition-colors ${!v.publishingLeaderShreds ? "opacity-40" : ""}`}
                    >
                      <TableCell className="text-cream">
                        <SelectValidatorButton
                          name={v.validatorName}
                          votePubkey={v.votePubkey}
                          onSelect={onSelect}
                        />
                        <span className="block text-xs text-cream-30">{shortenPubkey(v.nodePubkey)}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.contributorCode ? (
                          <Link
                            href={`/contributors/${v.contributorCode}`}
                            className="inline-flex items-center gap-1.5 text-cream-60 hover:text-cream"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span
                              className="size-1.5 rounded-full"
                              style={{ backgroundColor: getContributorColor(v.contributorCode) }}
                            />
                            {getContributorDisplayName(v.contributorCode)}
                          </Link>
                        ) : (
                          <span className="text-cream-30">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-cream-60 uppercase text-xs">{v.dzMetroCode}</TableCell>
                      <TableCell className="text-right text-cream-60 tabular-nums">
                        {formatNumber(v.activatedStake / LAMPORTS_PER_SOL, 0)}
                      </TableCell>
                      <TableCell className="text-right text-cream-60 tabular-nums">
                        {v.publishingLeaderShreds ? formatPercent(v.stakeSharePercent / 100) : "-"}
                      </TableCell>
                      <TableCell className="text-right text-cream-60 tabular-nums">
                        {formatNumber(v.leaderSlots)}
                      </TableCell>
                      <TableCell className="text-cream-60 text-xs">{v.validatorClient}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1 items-start">
                          <StatusBadge publishing={v.publishingLeaderShreds} backup={v.isBackup} />
                          {v.multicastConnected && (
                            <span className="rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/30 px-1.5 py-0.5 text-xs font-mono uppercase tracking-[0.1em]">
                              Multicast
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-cream-60 tabular-nums">
                        {v.publishingLeaderShreds ? `${formatSolFromSol(v.projectedRewardPerEpochSol, 4)} SOL` : "-"}
                      </TableCell>
                      <TableCell className="text-right text-cream-60 tabular-nums">
                        {v.publishingLeaderShreds ? `${formatSolFromSol(v.projectedRewardMonthlySol)} SOL` : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {filtered.length === 0 && (
                <p className="text-center text-sm text-cream-40 py-8">
                  {suppressEmptyMessage
                    ? "Not a connected validator — see the estimate above."
                    : "No validators match your search."}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Mobile: Card list */}
      <div className="md:hidden space-y-3 max-h-[600px] overflow-y-auto">
        <p className="font-display text-sm tracking-wide text-cream">
          {formatNumber(rewards.publishingValidatorCount)} Publishers
        </p>
        {filtered.length === 0 && (
          <p className="text-center text-sm text-cream-40 py-8">
            {suppressEmptyMessage
              ? "Not a connected validator — see the estimate above."
              : "No validators match your search."}
          </p>
        )}
        {filtered.map((v) => (
          <Card
            key={v.nodePubkey}
            onClick={() => onSelect(v.votePubkey)}
            className={`bg-cream-5 border-cream-8 cursor-pointer active:bg-cream-8 ${!v.publishingLeaderShreds ? "opacity-40" : ""}`}
          >
            <CardContent className="pt-4 pb-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <SelectValidatorButton
                    name={v.validatorName}
                    votePubkey={v.votePubkey}
                    onSelect={onSelect}
                    className="block text-sm text-cream"
                  />
                  <p className="text-xs text-cream-30">{shortenPubkey(v.nodePubkey)}</p>
                  {v.contributorCode && (
                    <Link
                      href={`/contributors/${v.contributorCode}`}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1 inline-flex items-center gap-1.5 text-xs text-cream-60"
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: getContributorColor(v.contributorCode) }}
                      />
                      {getContributorDisplayName(v.contributorCode)}
                    </Link>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge publishing={v.publishingLeaderShreds} backup={v.isBackup} />
                  {v.multicastConnected && (
                    <span className="rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/30 px-1.5 py-0.5 text-xs font-mono uppercase tracking-[0.1em]">
                      Multicast
                    </span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-cream-40">Metro </span>
                  <span className="text-cream-60 uppercase">{v.dzMetroCode}</span>
                </div>
                <div>
                  <span className="text-cream-40">Stake </span>
                  <span className="text-cream-60 tabular-nums">
                    {formatNumber(v.activatedStake / LAMPORTS_PER_SOL, 0)} SOL
                  </span>
                </div>
                <div>
                  <span className="text-cream-40">Share </span>
                  <span className="text-cream-60 tabular-nums">
                    {v.publishingLeaderShreds ? formatPercent(v.stakeSharePercent / 100) : "-"}
                  </span>
                </div>
                <div>
                  <span className="text-cream-40">Slots </span>
                  <span className="text-cream-60 tabular-nums">{formatNumber(v.leaderSlots)}</span>
                </div>
              </div>
              {v.publishingLeaderShreds && (
                <div className="flex items-center justify-between pt-2 border-t border-cream-8 text-xs">
                  <span className="text-cream-40">Est. reward / epoch</span>
                  <span className="text-cream font-medium tabular-nums">
                    {formatSolFromSol(v.projectedRewardPerEpochSol, 4)} SOL
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * The one focusable control in a row. The row itself takes pointer clicks
 * only: a row with role="button" loses its row semantics for screen readers
 * and turns the contributor link inside it into a control nested in a control.
 */
function SelectValidatorButton({
  name,
  votePubkey,
  onSelect,
  className = "",
}: {
  name: string;
  votePubkey: string;
  onSelect: (votePubkey: string) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(votePubkey);
      }}
      className={`text-left font-medium hover:underline decoration-dotted rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {name || "Unknown"}
      <span className="sr-only">, estimate earnings</span>
    </button>
  );
}

function MetricCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <Card className="bg-cream-5 border-cream-8">
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-cream-40 mb-1">{label}</p>
        <p className="text-xl font-display text-cream">{value}</p>
        {note && <p className="text-xs text-cream-20 mt-1">{note}</p>}
      </CardContent>
    </Card>
  );
}

function SortableHead({
  label,
  sortKey: key,
  currentKey,
  currentDir,
  onSort,
  align,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = currentKey === key;
  return (
    <TableHead className={align === "right" ? "text-right" : ""}>
      <button
        onClick={() => onSort(key)}
        className={`inline-flex items-center gap-1 text-cream-40 hover:text-cream transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded-sm ${
          align === "right" ? "ml-auto" : ""
        }`}
      >
        {label}
        {active ? (
          currentDir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}
