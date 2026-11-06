import { CASH_ROW_STORAGE_DEPOSIT, type Bid, type Cash, type Holding } from "@rose/sdk";
import { describe, expect, it, vi } from "vitest";
import { CASH_ROW_BYTES, chargedBytes, HOLDING_ROW_BYTES, OTHER_VENUE_ENTRY_BYTES, readStorageContext, STORAGE_BYTE_COST, STORAGE_RECORD_BYTES, storageNeed, type StorageContext } from "./engine-storage";

const NEAR = 10n ** 24n;
/** `storage_balance_bounds().min` of the engine (spec 4): 619 bytes, 0.00619 NEAR. */
const MINIMUM = (619n * NEAR) / 100_000n;
const SEED = "a".repeat(64);
const KOL = "b".repeat(64);
const ACCEPTED = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const NONE: StorageContext = { baseCashTokens: [ACCEPTED], exitRoundIds: new Set() };

function holding(classId: string, balance: bigint, claimable = 0n): Holding {
  return { classId, balance, lockedInRounds: 0n, encumbered: 0n, claimable, checkpoint: 0n };
}

function cash(amount: bigint): Cash[] {
  return [
    { venue: "Near", amount },
    { venue: { Base: { token: ACCEPTED } }, amount: 0n },
  ];
}

function buy(roundId: bigint, status: Bid["status"] = "Sealed"): Bid {
  return { roundId, bidId: 0, bidder: "buyer.testnet", side: "Buy", status, escrow: 1n, lockedUnits: 0n, bond: 1n, fee: 0n, cash: 0n, fillQuantity: 0n, ciphertextHex: null, placedAt: null, opened: null, void: null };
}

describe("engine storage rows", () => {
  it("match the engine's measured row sizes and the spec minimum", () => {
    expect(CASH_ROW_BYTES * STORAGE_BYTE_COST).toBe(CASH_ROW_STORAGE_DEPOSIT);
    expect((STORAGE_RECORD_BYTES + HOLDING_ROW_BYTES + CASH_ROW_BYTES) * STORAGE_BYTE_COST).toBe(MINIMUM);
    /* storage.rs: RECORD_OVERHEAD + (1 + 4 + MAX_ACCOUNT_LEN) + 4 + (4 + 42). */
    expect(OTHER_VENUE_ENTRY_BYTES).toBe(40n + (1n + 4n + 64n) + 4n + (4n + 42n));
  });

  it("counts the rows a portfolio holds (a holding row lives while its balance or claimable is non-zero)", () => {
    expect(chargedBytes({ holdings: [], cash: cash(0n), bids: [] }, NONE)).toBe(137n);
    expect(chargedBytes({ holdings: [holding(SEED, 5n), holding(KOL, 0n, 3n), holding("c".repeat(64), 0n)], cash: cash(1n), bids: [] }, NONE)).toBe(137n + 2n * 310n + 172n);
  });

  it("counts the holding row an open Exit buy reserves, not an Advance buy or a settled bid", () => {
    const context: StorageContext = { baseCashTokens: [], exitRoundIds: new Set([4n]) };
    expect(chargedBytes({ holdings: [], cash: [], bids: [buy(4n), buy(5n), buy(4n, "Settled")] }, context)).toBe(137n + 310n);
  });

  it("charges a Base cash row outside the accepted tokens its other-venue entry", () => {
    expect(chargedBytes({ holdings: [], cash: [{ venue: { Base: { token: OTHER } }, amount: 1n }], bids: [] }, NONE)).toBe(137n + 172n + 159n);
    expect(chargedBytes({ holdings: [], cash: [{ venue: { Base: { token: ACCEPTED.toUpperCase().replace("0X", "0x") } }, amount: 1n }], bids: [] }, NONE)).toBe(137n + 172n);
  });
});

describe("storageNeed", () => {
  it("registers an unregistered account with the minimum before its first cash deposit", () => {
    expect(storageNeed({ storage: null, minimum: MINIMUM, portfolio: { holdings: [], cash: cash(0n), bids: [] }, change: { cashVenue: "Near" }, context: NONE })).toEqual({ kind: "register", deposit: MINIMUM });
  });

  it("asks nothing when the minimum already covers the new row", () => {
    const storage = { total: MINIMUM, available: 0n };
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n)], cash: cash(0n), bids: [] }, change: { cashVenue: "Near" }, context: NONE })).toBeNull();
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [], cash: cash(10n), bids: [] }, change: { classId: SEED }, context: NONE })).toBeNull();
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [], cash: cash(10n), bids: [] }, change: { cashVenue: "Near" }, context: NONE })).toBeNull();
  });

  it("tops up exactly one row for an account that already fills its deposit", () => {
    const storage = { total: MINIMUM, available: 0n };
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n)], cash: cash(10n), bids: [] }, change: { classId: KOL }, context: NONE })).toEqual({ kind: "top_up", deposit: HOLDING_ROW_BYTES * STORAGE_BYTE_COST });
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n), holding(KOL, 1n)], cash: cash(0n), bids: [] }, change: { cashVenue: "Near" }, context: NONE })).toEqual({ kind: "top_up", deposit: (137n + 2n * 310n + 172n - 619n) * STORAGE_BYTE_COST });
  });

  it("covers an account registered with a zero deposit by the engine, even when no row is added", () => {
    const storage = { total: 0n, available: 0n };
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n)], cash: cash(0n), bids: [] }, change: { cashVenue: "Near" }, context: NONE })).toEqual({ kind: "top_up", deposit: (137n + 310n + 172n) * STORAGE_BYTE_COST });
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [holding(SEED, 5n)], cash: cash(10n), bids: [] }, change: { cashVenue: "Near", classId: SEED }, context: NONE })).toEqual({ kind: "top_up", deposit: (137n + 310n + 172n) * STORAGE_BYTE_COST });
  });

  it("asks for a top-up at the minimum with one holding and an open Exit bid on a second class (the review case)", () => {
    const storage = { total: MINIMUM, available: 0n };
    const context: StorageContext = { baseCashTokens: [], exitRoundIds: new Set([7n]) };
    const portfolio = { holdings: [holding(SEED, 5n)], cash: [], bids: [buy(7n)] };
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio, change: { cashVenue: "Near" }, context })).toEqual({ kind: "top_up", deposit: (137n + 2n * 310n + 172n - 619n) * STORAGE_BYTE_COST });
  });

  it("reads the bytes in use exactly from storage_balance_of when the deposit exceeds them and the minimum", () => {
    /* 2,000 bytes deposited, 1,100 in use: available 900 bytes. The rebuild (137) is ignored. */
    const storage = { total: 2_000n * STORAGE_BYTE_COST, available: 900n * STORAGE_BYTE_COST };
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [], cash: [], bids: [] }, change: { classId: SEED }, context: NONE })).toBeNull();
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [], cash: [], bids: [] }, change: { classId: SEED, cashVenue: { Base: { token: OTHER } } }, context: NONE })).toBeNull();
    const tight = { total: 1_400n * STORAGE_BYTE_COST, available: 300n * STORAGE_BYTE_COST };
    expect(storageNeed({ storage: tight, minimum: MINIMUM, portfolio: { holdings: [], cash: [], bids: [] }, change: { classId: SEED }, context: NONE })).toEqual({ kind: "top_up", deposit: 10n * STORAGE_BYTE_COST });
  });

  it("caps the rebuild at the minimum when the deposit shows the usage is below it", () => {
    /* 1,000 bytes deposited, available 381: the usage is at most 619 bytes, so an over-counted rebuild (two reserved rows) is capped. */
    const storage = { total: 1_000n * STORAGE_BYTE_COST, available: 381n * STORAGE_BYTE_COST };
    const context: StorageContext = { baseCashTokens: [], exitRoundIds: new Set([1n, 2n]) };
    expect(storageNeed({ storage, minimum: MINIMUM, portfolio: { holdings: [], cash: [], bids: [buy(1n), buy(2n)] }, change: { classId: SEED }, context })).toBeNull();
  });
});

describe("readStorageContext", () => {
  it("reads the config only for Base rows and the kinds of the open buy bids' rounds it does not know", async () => {
    const getConfig = vi.fn(() => Promise.resolve({ base_cash_tokens: [ACCEPTED] }));
    const getRound = vi.fn((id: bigint | number | string) => Promise.resolve({ roundId: BigInt(id), kind: BigInt(id) === 3n ? ("Advance" as const) : ("Exit" as const) }));
    const views = { getConfig, getRound } as unknown as Parameters<typeof readStorageContext>[0];
    const nearOnly = await readStorageContext(views, { holdings: [], cash: cash(5n), bids: [buy(2n), buy(3n), buy(9n, "Settled")] }, { classId: SEED }, { known: [{ roundId: 2n, kind: "Exit" }] });
    expect(getConfig).not.toHaveBeenCalled();
    expect(getRound).toHaveBeenCalledTimes(1);
    expect([...nearOnly.exitRoundIds]).toEqual([2n]);
    const base = await readStorageContext(views, { holdings: [], cash: [], bids: [] }, { cashVenue: { Base: { token: OTHER } } });
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(base.baseCashTokens).toEqual([ACCEPTED]);
  });
});
