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
 * Find underserved city pairs (high demand, few links).
 */
export function findCoverageGaps(
  cityDemands: CityDemand[],
  limit = 20
): { cityA: CityDemand; cityB: CityDemand; score: number }[] {
  const gaps: { cityA: CityDemand; cityB: CityDemand; score: number }[] = [];

  // Only consider cities with some demand
  const activeCities = cityDemands.filter((c) => c.totalSlots > 0);

  for (let i = 0; i < activeCities.length; i++) {
    for (let j = i + 1; j < activeCities.length; j++) {
      const cityA = activeCities[i];
      const cityB = activeCities[j];
      // Score = combined demand divided by combined existing links (higher = more underserved)
      const combinedDemand = cityA.demandScore + cityB.demandScore;
      const combinedLinks = cityA.linkCount + cityB.linkCount;
      const score = combinedLinks > 0 ? combinedDemand / combinedLinks : combinedDemand * 10;

      gaps.push({ cityA, cityB, score });
    }
  }

  gaps.sort((a, b) => b.score - a.score);
  return gaps.slice(0, limit);
}
