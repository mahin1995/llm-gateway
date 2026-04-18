import { describe, expect, it } from "vitest";
import { Tier } from "@prisma/client";
import { isTierAllowed, tierSequence } from "./tiers.js";

describe("tier policy", () => {
  it("allows requests up to the configured max tier", () => {
    expect(isTierAllowed(Tier.L1, Tier.L1)).toBe(true);
    expect(isTierAllowed(Tier.L2, Tier.L3)).toBe(true);
    expect(isTierAllowed(Tier.L3, Tier.L2)).toBe(false);
  });

  it("builds a bounded escalation sequence", () => {
    expect(tierSequence(Tier.L1, Tier.L3)).toEqual([Tier.L1, Tier.L2, Tier.L3]);
    expect(tierSequence(Tier.L2, Tier.L3)).toEqual([Tier.L2, Tier.L3]);
    expect(tierSequence(Tier.L1, Tier.L1)).toEqual([Tier.L1]);
  });
});
