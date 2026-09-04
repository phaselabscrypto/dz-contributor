/**
 * Check that the TypeScript extractor still produces the shapes the Rust diff
 * tests assert against.
 *
 * This is the seam. `extractDiffShape` runs in the Vercel cron; the diffs it
 * feeds run in the Rust service; `services/shapley-rs/tests/diff_parity.rs`
 * pins the response bodies against captures taken from production. That Rust
 * test reads committed shape fixtures, so on its own it cannot notice the
 * extractor drifting. This script closes the loop by regenerating the fixtures
 * from the real snapshots and comparing.
 *
 *   pnpm run test:diff-shape            verify against the committed fixtures
 *   pnpm run test:diff-shape -- --write regenerate them
 *
 * Reads eight ~110 MB snapshots, so it is a few minutes on a home connection
 * and is not part of `pnpm run lint` or the default CI job.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { getSnapshotUrl } from "@/lib/constants/config";
import type { RawSnapshot } from "@/lib/types/snapshot";
import type { DiffShapeRecord } from "@/lib/types/diff";
import { extractDiffShape } from "@/lib/utils/diff-shape";

/** The window `diff_parity.rs` compares against the production captures. */
const FIRST_EPOCH = 204;
const LAST_EPOCH = 211;

const FIXTURE_DIR = join(
  process.cwd(),
  "services/shapley-rs/tests/fixtures/diff/shapes",
);

const isWriting = process.argv.includes("--write");

function fixturePath(epoch: number): string {
  return join(FIXTURE_DIR, `epoch-${String(epoch).padStart(6, "0")}.json`);
}

async function shapeFor(epoch: number): Promise<DiffShapeRecord> {
  const response = await fetch(getSnapshotUrl(epoch));
  if (!response.ok) {
    throw new Error(`epoch ${epoch}: snapshot HTTP ${response.status}`);
  }
  const raw: RawSnapshot = await response.json();
  const shape = extractDiffShape(raw);
  if (shape.epoch !== epoch) {
    throw new Error(
      `epoch ${epoch}: snapshot carries dz_epoch ${shape.epoch}`,
    );
  }
  return shape;
}

async function main(): Promise<void> {
  if (isWriting) mkdirSync(FIXTURE_DIR, { recursive: true });

  let failures = 0;
  for (let epoch = FIRST_EPOCH; epoch <= LAST_EPOCH; epoch += 1) {
    const started = Date.now();
    const shape = await shapeFor(epoch);
    // Two-space JSON with a trailing newline, so a regeneration produces a
    // clean diff rather than a one-line churn.
    const serialized = `${JSON.stringify(shape, null, 2)}\n`;
    const path = fixturePath(epoch);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (isWriting) {
      writeFileSync(path, serialized);
      console.log(
        `wrote  epoch ${epoch}  ${shape.links.length} links  ` +
          `${shape.contributors.length} contributors  ${elapsed}s`,
      );
      continue;
    }

    if (!existsSync(path)) {
      console.error(`MISSING epoch ${epoch}: ${path}`);
      console.error("        regenerate with: pnpm run test:diff-shape -- --write");
      failures += 1;
      continue;
    }
    if (readFileSync(path, "utf8") !== serialized) {
      console.error(
        `DRIFT   epoch ${epoch}: the extractor no longer produces the committed fixture`,
      );
      console.error(
        "        If this is intended, regenerate AND bump DIFF_SHAPE_VERSION_PREFIX",
      );
      console.error(
        "        in services/shapley-rs/src/diff_store.rs, or already-persisted",
      );
      console.error("        records will be served alongside the new shape.");
      failures += 1;
      continue;
    }
    console.log(
      `ok     epoch ${epoch}  ${shape.links.length} links  ` +
        `${shape.contributors.length} contributors  ${elapsed}s`,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} epoch(s) failed`);
    process.exit(1);
  }
  console.log(
    `\n${LAST_EPOCH - FIRST_EPOCH + 1} epochs ${isWriting ? "written" : "match"}`,
  );
}

void main();
