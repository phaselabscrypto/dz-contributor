import { MIN_DZ_EPOCH } from "@/lib/constants/config";
import { MAX_DIFF_EPOCH } from "@/lib/utils/diff-window";

export interface DiffRepairSchedule {
  selected: number[];
  deferred: number[];
}

export function scheduleDiffRepairs(missing: readonly number[], currentEpoch: number, maxAttempts: number, scheduleSlot: number): DiffRepairSchedule {
  if (![currentEpoch, ...missing].every(epoch => Number.isInteger(epoch) && epoch >= MIN_DZ_EPOCH && epoch <= MAX_DIFF_EPOCH && epoch <= currentEpoch)
    || !Number.isInteger(maxAttempts) || maxAttempts < 0 || !Number.isSafeInteger(scheduleSlot) || scheduleSlot < 0) {
    throw new RangeError("invalid diff repair schedule");
  }
  const remaining = [...new Set(missing)].sort((a, b) => a - b);
  const selected: number[] = [];
  const currentIndex = remaining.indexOf(currentEpoch);
  if (currentIndex !== -1 && selected.length < maxAttempts) selected.push(...remaining.splice(currentIndex, 1));
  if (remaining.length > 0 && selected.length < maxAttempts) selected.push(remaining.pop()!);
  if (remaining.length > 0) {
    const offset = scheduleSlot % remaining.length;
    const rotated = [...remaining.slice(offset), ...remaining.slice(0, offset)];
    selected.push(...rotated.slice(0, maxAttempts - selected.length));
  }
  return { selected, deferred: remaining.filter(epoch => !selected.includes(epoch)) };
}
