import { describe, expect, it } from "vitest";
import { amountToText, formatDuration, formatFraction, isNearAccountId, isSolanaAddress, parseAmount, sameVenue, tokensAtFraction, venueLabel } from "./amounts";

describe("parseAmount", () => {
  it("parses decimals exactly into base units", () => {
    expect(parseAmount("1", 6)).toBe(1_000_000n);
    expect(parseAmount("0.5", 6)).toBe(500_000n);
    expect(parseAmount("1,25", 2)).toBe(125n);
    expect(parseAmount(" 12.000001 ", 6)).toBe(12_000_001n);
    expect(parseAmount("0", 18)).toBe(0n);
    expect(parseAmount("123456789.123456789012345678", 18)).toBe(123456789123456789012345678n);
  });
  it("rejects text that is not an amount or has too many decimals", () => {
    expect(parseAmount("", 6)).toBeNull();
    expect(parseAmount(".", 6)).toBeNull();
    expect(parseAmount("1e3", 6)).toBeNull();
    expect(parseAmount("-1", 6)).toBeNull();
    expect(parseAmount("0.1234567", 6)).toBeNull();
    expect(parseAmount("abc", 6)).toBeNull();
  });
  it("round-trips through amountToText", () => {
    for (const text of ["1", "0.5", "12.000001", "1000000"]) expect(amountToText(parseAmount(text, 6)!, 6)).toBe(text);
    expect(amountToText(1_500_000_000_000_000_000n, 18)).toBe("1.5");
  });
});

describe("fractions and amounts", () => {
  it("formats a 1e18 fraction as a percentage", () => {
    expect(formatFraction(250_000_000_000_000_000n)).toBe("25.0%");
    expect(formatFraction(1_000_000_000_000_000_000n)).toBe("100.0%");
    expect(formatFraction(0n, 0)).toBe("0%");
    expect(formatFraction(123_456_789_012_345_678n, 2)).toBe("12.34%");
  });
  it("computes tokens at a fraction rounding down", () => {
    expect(tokensAtFraction(1_000n, 250_000_000_000_000_000n)).toBe(250n);
    expect(tokensAtFraction(3n, 500_000_000_000_000_000n)).toBe(1n);
  });
  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatDuration(2 * 86_400 + 4 * 3600)).toBe("2d 4h");
  });
});

describe("venues and addresses", () => {
  it("labels venues and compares them case-insensitively", () => {
    expect(venueLabel("Near")).toBe("NEAR tUSDC");
    expect(venueLabel({ Base: { token: "0xABCDEF0000000000000000000000000000000001" } }, new Map([["0xabcdef0000000000000000000000000000000001", "tUSDC"]]))).toBe("Base tUSDC");
    expect(sameVenue({ Base: { token: "0xAB" } }, { Base: { token: "0xab" } })).toBe(true);
    expect(sameVenue("Near", { Base: { token: "0xab" } })).toBe(false);
  });
  it("validates NEAR account ids and Solana addresses", () => {
    expect(isNearAccountId("alice.testnet")).toBe(true);
    expect(isNearAccountId("rose-demo-ab12cd.testnet")).toBe(true);
    expect(isNearAccountId("Alice.testnet")).toBe(false);
    expect(isNearAccountId("a")).toBe(false);
    expect(isSolanaAddress("HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ")).toBe(true);
    expect(isSolanaAddress("0x1234")).toBe(false);
  });
});
