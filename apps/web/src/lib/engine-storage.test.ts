import { CASH_ROW_STORAGE_DEPOSIT, type Cash, type Holding } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { CASH_ROW_BYTES, chargedBytes, HOLDING_ROW_BYTES, STORAGE_BYTE_COST, STORAGE_RECORD_BYTES, storageNeed } from "./engine-storage";

const NEAR = 10n ** 24n;
/** `storage_balance_bounds().min` of the engine (spec 4): 619 bytes, 0.00619 NEAR. */
const MINIMUM = (619n * NEAR) / 100_000n;
const SEED = "a".repeat(64);
const KOL = "b".repeat(64);

function holding(classId: string, balance: bigint, claimable = 0n): Holding {
  return { classId, balance, lockedInRounds: 0n, encumbered: 0n, claimable, checkpoint: 0n };
}

function cash(amount: bigint): Cash[] {
  return [
    { venue: "Near", amount },
    { venue: { Base: { token: "0x3333333333333333333333333333333333333333" } }, amount: 0n },
  ];
}

describe("engine storage rows", () => {
  it("match the engine's measured row sizes and the spec minimum", () => {
    expect(CASH_ROW_BYTES * STORAGE_BYTE_COST).toBe(CASH_ROW_STORAGE_DEPOSIT);
    expect((STORAGE_RECORD_BYTES + HOLDING_ROW_BYTES + CASH_ROW_BYTES) * STORAGE_BYTE_COST).toBe(MINIMUM);
  });

  it("counts the rows a portfolio holds (a holding row lives while its balance or claimable is non-zero)", () => {
    expect(chargedBytes({ holdings: [], cash: cash(0n) })).toBe(137n);
    expect(chargedBytes({ holdings: [holding(SEED, 5n), holding(KOL, 0n, 3n), holding("c".repeat(64), 0n)], cash: cash(1n) })).toBe(137n + 2n * 310n + 172n);
  });
});

describe("storageNeed", () => {
  it("registers an unregistered account with the minimum before its first cash deposit", () => {
    expect(storageNeed({ storage: null, minimum: MINIMUM, portfolio: { holdings: [], cash: cash(0n) }, change: { cashVenue: "Near" } })).toEqual({ kind: "register", deposit: MINIMUM });
  });

  it("asks nothing when the minimum already covers the new row", () => {
    const storage = { total: MINIMUM, available: 0n };
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n)], cash: cash(0n) }, change: { cashVenue: "Near" } })).toBeNull();
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [], cash: cash(10n) }, change: { classId: SEED } })).toBeNull();
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [], cash: cash(10n) }, change: { cashVenue: "Near" } })).toBeNull();
  });

  it("tops up exactly one row for an account that already fills its deposit", () => {
    const storage = { total: MINIMUM, available: 0n };
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n)], cash: cash(10n) }, change: { classId: KOL } })).toEqual({ kind: "top_up", deposit: HOLDING_ROW_BYTES * STORAGE_BYTE_COST });
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n), holding(KOL, 1n)], cash: cash(0n) }, change: { cashVenue: "Near" } })).toEqual({ kind: "top_up", deposit: (137n + 2n * 310n + 172n - 619n) * STORAGE_BYTE_COST });
  });

  it("covers an account registered with a zero deposit by the engine, even when no row is added", () => {
    const storage = { total: 0n, available: 0n };
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n)], cash: cash(0n) }, change: { cashVenue: "Near" } })).toEqual({ kind: "top_up", deposit: (137n + 310n + 172n) * STORAGE_BYTE_COST });
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n)], cash: cash(10n) }, change: { cashVenue: "Near", classId: SEED } })).toEqual({ kind: "top_up", deposit: (137n + 310n + 172n) * STORAGE_BYTE_COST });
  });
});
