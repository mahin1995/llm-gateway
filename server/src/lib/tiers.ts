import { Tier } from "@prisma/client";

const tierRank: Record<Tier, number> = {
  L1: 1,
  L2: 2,
  L3: 3
};

export function isTierAllowed(requested: Tier, maxTier: Tier): boolean {
  return tierRank[requested] <= tierRank[maxTier];
}

export function tierSequence(startTier: Tier, maxTier: Tier): Tier[] {
  const allTiers = [Tier.L1, Tier.L2, Tier.L3];
  return allTiers.filter((tier) => tierRank[tier] >= tierRank[startTier] && tierRank[tier] <= tierRank[maxTier]);
}
