import { ONE } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { holderBond, maxClaim, validateAdvance } from "./math";

const HALF = ONE / 2n;

describe("maxClaim", () => {
  it("is the locked part of the units at settlement", () => {
    expect(maxClaim(1000n, HALF)).toBe(500n);
    expect(maxClaim(1000n, 0n)).toBe(1000n);
    expect(maxClaim(1000n, ONE)).toBe(0n);
    expect(maxClaim(3_333_333n, HALF)).toBe(1_666_666n);
  });
});

describe("holderBond", () => {
  it("is 1% of the claim valued at the price ceiling, floored at 1 USDC", () => {
    expect(holderBond(100n * 10n ** 18n, 10_000_000n, 18, 1_000_000n)).toBe(10_000_000n);
    expect(holderBond(1n * 10n ** 18n, 10_000_000n, 18, 1_000_000n)).toBe(1_000_000n);
  });
});

describe("validateAdvance", () => {
  const now = 1_762_200_000_000;
  const base = { units: 1000n, claim: 400n, reserve: 5_000_000n, minFill: 100n, maxPrice: 9_000_000n, closesAtMs: now + 86_400_000 };
  const context = { freeUnits: 1000n, fTs: HALF, nowMs: now, cash: 100_000_000n, bond: 1_000_000n, decimals: 0 };
  it("accepts a well-formed Advance", () => {
    expect(validateAdvance(base, context)).toEqual({});
  });
  it("bounds the claim by the locked part, the min fill by the claim and the reserve by the ceiling", () => {
    expect(validateAdvance({ ...base, claim: 501n }, context).claim).toMatch(/At most 500 tokens/);
    expect(validateAdvance({ ...base, minFill: 401n }, context).minFill).toBeDefined();
    expect(validateAdvance({ ...base, reserve: 9_000_001n }, context).reserve).toBeDefined();
    expect(validateAdvance({ ...base, units: 1001n }, context).units).toBe("More than your free units");
  });
  it("refuses a fully unlocked settlement time, a past close and an uncovered bond", () => {
    expect(validateAdvance(base, { ...context, fTs: ONE }).closesAtMs).toMatch(/fully unlocked/);
    expect(validateAdvance({ ...base, closesAtMs: now }, context).closesAtMs).toMatch(/at least a minute/);
    expect(validateAdvance(base, { ...context, cash: 0n }).maxPrice).toBe("Your cash in the venue (0.00 USDC) does not cover the 1.00 USDC bond");
  });
});
