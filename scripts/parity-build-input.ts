// Parity helper: build our canonical ShapleyInput from a raw DZ snapshot and
// print a summary, for diffing against DZ's own `inspect shapley` output and for
// feeding the shapley service. Uses the builder's config default (DZ-current)
// unless PARITY_EPOCH149=1 forces the historical epoch-149 params.
//
//   npx tsx scripts/parity-build-input.ts <snapshot.json> <out.json>
import { readFileSync, writeFileSync } from "node:fs";

import { buildCanonicalShapleyInput } from "@/lib/utils/canonical-input-builder";
import type { RawSnapshot } from "@/lib/types/snapshot";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: tsx scripts/parity-build-input.ts <snapshot.json> <out.json>");
  process.exit(1);
}

const override =
  process.env.PARITY_EPOCH149 === "1"
    ? { ibrlPriority: 0.0, publicLatencyMultiplier: 1.0 }
    : undefined;

const raw = JSON.parse(readFileSync(inPath, "utf8")) as RawSnapshot;
const result = buildCanonicalShapleyInput(raw, override);
if (!result.canonical) {
  throw new Error(`canonical builder declined: ${result.reason}`);
}
const input = result.input;
writeFileSync(outPath, JSON.stringify(input));

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const summary = {
  mode: override ? "epoch-149 (historical override)" : "DZ-current (config default)",
  operators: uniq(input.devices.map((d) => d.operator)).length,
  devices: input.devices.length,
  private_links: input.private_links.length,
  public_links: input.public_links.length,
  demands: input.demands.length,
  city_weights: Object.keys(input.city_weights ?? {}).length,
  ibrl_priorities: uniq(input.demands.filter((d) => !d.multicast).map((d) => d.priority)),
  shred_priorities_sample: uniq(input.demands.filter((d) => d.multicast).map((d) => d.priority)).slice(0, 5),
  public_latency_sample: input.public_links.slice(0, 5).map((l) => l.latency),
};
console.log(JSON.stringify(summary, null, 2));
