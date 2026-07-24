import type { CityDemand } from "@/lib/types/contributor";

/**
 * Estimate the reward delta when a contributor switches a link.
 * Returns a value between -1 and 1 representing estimated % change in rewards.
 */
export function estimateRewardDelta(
  currentLinkDemand: number,
  newLocationDemand: number,
  totalDemand: number
): number {
  if (totalDemand === 0) return 0;
  // Directional estimate: positive if moving to higher demand
  const delta = (newLocationDemand - currentLinkDemand) / totalDemand;
  return Math.max(-1, Math.min(1, delta));
}

/**
 * Estimate the reward share a new single-link contributor would receive.
 * Based on their coverage relative to existing contributors.
 */
export function estimateNewContributorShare(
  linkCityADemand: number,
  linkCityZDemand: number,
  totalDemand: number,
  existingContributorCount: number
): number {
  if (totalDemand === 0 || existingContributorCount === 0) return 0;
  const linkValue = (linkCityADemand + linkCityZDemand) / 2;
  // Rough estimate: new contributor's share ~ their link value / (total + their value)
  const share = linkValue / (totalDemand + linkValue);
  return share;
}

/**
 * Find underserved city pairs (high demand, few links) to suggest as routes.
 *
 * Two things beyond raw scoring keep the suggestions useful:
 *  - Each pair is oriented so the higher-demand endpoint is `cityA` (the
 *    "origin"), then capped at one suggestion per origin metro. Without this the
 *    single busiest city becomes the origin of every top-scored pair and the
 *    list reads as one repeated origin.
 *  - Intra-metro pairs are skipped entirely: they earn no reward and are
 *    rejected server-side, so suggesting one would stage a link that 400s on
 *    Calculate.
 */
export function findCoverageGaps(
  cityDemands: CityDemand[],
  limit = 20
): { cityA: CityDemand; cityB: CityDemand; score: number }[] {
  // Only consider cities with some demand
  const activeCities = cityDemands.filter((c) => c.totalSlots > 0);

  const gaps: { cityA: CityDemand; cityB: CityDemand; score: number }[] = [];
  for (let i = 0; i < activeCities.length; i++) {
    for (let j = i + 1; j < activeCities.length; j++) {
      let cityA = activeCities[i];
      let cityB = activeCities[j];
      // Origin = higher-demand endpoint, so the origin key below is
      // deterministic and independent of input array order.
      if (cityB.demandScore > cityA.demandScore) {
        [cityA, cityB] = [cityB, cityA];
      }
      // Intra-metro pairs are a reward no-op and are rejected server-side.
      if (cityA.metroCode !== undefined && cityA.metroCode === cityB.metroCode) {
        continue;
      }
      // Score = combined demand divided by combined existing links (higher = more underserved)
      const combinedDemand = cityA.demandScore + cityB.demandScore;
      const combinedLinks = cityA.linkCount + cityB.linkCount;
      const score = combinedLinks > 0 ? combinedDemand / combinedLinks : combinedDemand * 10;

      gaps.push({ cityA, cityB, score });
    }
  }

  gaps.sort((a, b) => b.score - a.score);

  // Origin key: metro if known, else locationCode so a metro-less city takes
  // exactly one origin slot instead of collapsing all of them into `undefined`.
  const originKey = (c: CityDemand): string => c.metroCode ?? c.locationCode;

  // Pass 1: at most one suggestion per origin, highest score first.
  const seenOrigins = new Set<string>();
  const selected: typeof gaps = [];
  for (const gap of gaps) {
    if (selected.length >= limit) break;
    const key = originKey(gap.cityA);
    if (seenOrigins.has(key)) continue;
    seenOrigins.add(key);
    selected.push(gap);
  }

  // Pass 2 (top-up): if there are fewer distinct origins than `limit`, fill the
  // remaining slots with the next-highest-scoring pairs we skipped. Reference
  // identity works because `selected` holds the exact objects from `gaps`.
  if (selected.length < limit) {
    const chosen = new Set(selected);
    for (const gap of gaps) {
      if (selected.length >= limit) break;
      if (chosen.has(gap)) continue;
      selected.push(gap);
    }
  }

  // Re-sort the final set by score desc (a top-up pick can outscore a later
  // pass-1 pick) so the returned order is predictable.
  selected.sort((a, b) => b.score - a.score);
  return selected;
}
