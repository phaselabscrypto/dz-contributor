/**
 * Fill the diff index's deep history, one epoch at a time.
 *
 * The cron repairs the last 31 epochs, which is the window the changelog
 * selector offers. Everything older is this script's job, and it is a one-off:
 * epochs are immutable, so a record written once is never rewritten.
 *
 *   pnpm run backfill:diff                     from the latest epoch backwards
 *   pnpm run backfill:diff -- --from 180       start at a specific epoch
 *   pnpm run backfill:diff -- --count 20       stop after 20 epochs
 *   pnpm run backfill:diff -- --dry-run        report what is missing, write nothing
 *
 * Needs SHAPLEY_SERVICE_URL, SHAPLEY_API_TOKEN and SHAPLEY_INGEST_TOKEN.
 * Each epoch is a ~110 MB download, so the whole history is a few hours and a
 * lot of bandwidth. Safe to interrupt and re-run: an epoch already stored
 * answers 409 and is counted as done.
 */

import { getSnapshotUrl, MIN_DZ_EPOCH } from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import { extractDiffShape } from "@/lib/utils/diff-shape";
import { getEpochAvailability } from "@/lib/utils/epoch-discovery";
import { fetchMissingDiffShapes, putDiffShape } from "@/lib/utils/shapley-remote";

/** How far back one `GET /diff/missing` call looks. */
const MISSING_PAGE = 200;

function numericArg(name: string): number | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) ? value : null;
}

const isDryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const from = numericArg("from") ?? (await getEpochAvailability(false)).latest;
  const count = numericArg("count") ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isInteger(from) || from < MIN_DZ_EPOCH) {
    throw new Error(`--from must be an integer >= ${MIN_DZ_EPOCH}`);
  }

  // Ask the service what it lacks rather than probing epoch by epoch, so a
  // re-run after an interruption skips everything already stored.
  const missing: number[] = [];
  for (let top = from; top >= MIN_DZ_EPOCH; top -= MISSING_PAGE) {
    const page = await fetchMissingDiffShapes(top, MISSING_PAGE);
    missing.push(...page.filter((epoch) => epoch <= from));
    if (top - MISSING_PAGE < MIN_DZ_EPOCH) break;
  }
  // Newest first: the epochs a user is most likely to ask for land soonest.
  const targets = [...new Set(missing)].sort((a, b) => b - a).slice(0, count);

  console.log(
    `${missing.length} epoch(s) missing at or below ${from}; ` +
      `${isDryRun ? "would process" : "processing"} ${targets.length}`,
  );
  if (isDryRun || targets.length === 0) {
    if (targets.length > 0) console.log(targets.join(" "));
    return;
  }

  let created = 0;
  let existed = 0;
  const failed: number[] = [];

  for (const [index, epoch] of targets.entries()) {
    const started = Date.now();
    try {
      const response = await fetch(getSnapshotUrl(epoch));
      if (!response.ok) {
        throw new Error(`snapshot HTTP ${response.status}`);
      }
      const raw: RawSnapshot = await response.json();
      const outcome = await putDiffShape(extractDiffShape(raw));
      if (outcome === "created") created += 1;
      else existed += 1;
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `[${index + 1}/${targets.length}] epoch ${epoch} ${outcome} ${elapsed}s`,
      );
    } catch (err) {
      // One bad epoch must not end the run: a snapshot can be absent for an
      // epoch the bucket never published.
      failed.push(epoch);
      console.error(
        `[${index + 1}/${targets.length}] epoch ${epoch} FAILED: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`\ncreated ${created}, already present ${existed}, failed ${failed.length}`);
  if (failed.length > 0) {
    console.error(`failed epochs: ${failed.join(" ")}`);
    process.exit(1);
  }
}

void main();
