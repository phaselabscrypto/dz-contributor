import { MIN_DZ_EPOCH } from "@/lib/constants/config";
import { MAX_DIFF_EPOCH } from "@/lib/utils/diff-window";

export interface DiffRepairSchedule {
  /** Epochs to download this fire, in attempt order. */
  selected: number[];
  /** Epochs left for a later fire, ascending. */
  deferred: number[];
}

function isEpochInWindow(epoch: number, currentEpoch: number): boolean {
  return (
    Number.isInteger(epoch) &&
    epoch >= MIN_DZ_EPOCH &&
    epoch <= MAX_DIFF_EPOCH &&
    epoch <= currentEpoch
  );
}

/**
 * Pick which missing shapes one cron fire repairs. The current epoch goes
 * first, then the newest gap, then the remaining gaps rotated by
 * `scheduleSlot`, so one persistent gap cannot starve the older ones.
 * `maxAttempts` counts the current epoch.
 */
export function scheduleDiffRepairs(
  missing: readonly number[],
  currentEpoch: number,
  maxAttempts: number,
  scheduleSlot: number,
): DiffRepairSchedule {
  const isValidWindow = [currentEpoch, ...missing].every((epoch) =>
    isEpochInWindow(epoch, currentEpoch),
  );
  const isValidBudget = Number.isInteger(maxAttempts) && maxAttempts >= 0;
  const isValidSlot = Number.isSafeInteger(scheduleSlot) && scheduleSlot >= 0;
  if (!isValidWindow || !isValidBudget || !isValidSlot) {
    throw new RangeError("invalid diff repair schedule");
  }

  const remaining = [...new Set(missing)].sort((a, b) => a - b);
  const selected: number[] = [];
  const take = (index: number): void => {
    if (index >= 0 && selected.length < maxAttempts) {
      selected.push(...remaining.splice(index, 1));
    }
  };
  take(remaining.indexOf(currentEpoch));
  take(remaining.length - 1);
  if (remaining.length > 0) {
    const offset = scheduleSlot % remaining.length;
    const rotated = [...remaining.slice(offset), ...remaining.slice(0, offset)];
    selected.push(...rotated.slice(0, maxAttempts - selected.length));
  }
  const chosen = new Set(selected);
  return {
    selected,
    deferred: remaining.filter((epoch) => !chosen.has(epoch)),
  };
}
