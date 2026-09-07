import { CANONICAL_SHAPLEY_PARAMS } from "@/lib/constants/config";

export const CANONICAL_SWEEP_VERSION = "canonical-v1";

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function canonicalParamsFingerprint(): string {
  const params = CANONICAL_SHAPLEY_PARAMS;
  return fnv1a(
    `ibrl=${params.ibrlPriority};plm=${params.publicLatencyMultiplier}`,
  );
}

export function sweepTag(epoch: number): string {
  return `epoch-${epoch}:${CANONICAL_SWEEP_VERSION}:${canonicalParamsFingerprint()}`;
}
