import { ONE, perClaimedToken, type Round } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { fractionAt } from "@/lib/unlock-schedule";
import { bondFor, cancelledOutcome, cancelNoKeyAt, canCancelAsCreator, canCancelNoKey, canClose, clearingOf, formatQty, formatUsdc, KEY_REQUEST_FLIGHT_NS, lockedPercent, msToNs, nextAction, parseDecimal, previewBuy, previewSell, roundPricing, roundProgress, timeline } from "./model";

const NOW_MS = 1_762_200_000_000;
const SEC = 1_000_000_000n;

function round(overrides: Partial<Round> = {}): Round {
  const closesAt = msToNs(NOW_MS) + 3600n * SEC;
  return {
    roundId: 7n,
    kind: "Exit",
    classId: "a".repeat(64),
    venue: "Near",
    creator: "alice.testnet",
    status: "Open",
    appId: "b".repeat(64),
    opensAt: msToNs(NOW_MS) - 3600n * SEC,
    closesAt,
    keyTimeout: 3600n * SEC,
    revealWindow: 600n * SEC,
    maxPrice: 10_000_000n,
    fTs: 250_000_000_000_000_000n,
    remainingLockSecs: 86_400n * 100n,
    bidCount: 3,
    openedCount: 0,
    settledCount: 0,
    createdAt: msToNs(NOW_MS) - 7200n * SEC,
    budget: null,
    issuerEscrow: null,
    referencePrice: null,
    retireTo: null,
    advanceUnits: null,
    advanceClaim: null,
    advanceMinFill: null,
    lienId: null,
    closeRequestedAt: null,
    key: null,
    keySource: null,
    keyReceivedAt: null,
    revealEndsAt: null,
    endedAt: null,
    cancelReason: null,
    result: null,
    ...overrides,
  };
}

describe("formatting", () => {
  it("formats USDC with at least two fraction digits and no rounding up", () => {
    expect(formatUsdc(7_200_000n)).toBe("7.20");
    expect(formatUsdc(8_500_000n)).toBe("8.50");
    expect(formatUsdc(1_425_002n)).toBe("1.425002");
    expect(formatUsdc(1_000_000n)).toBe("1.00");
    expect(formatUsdc(999_999_999n)).toBe("999.999999");
    expect(formatUsdc(0n)).toBe("0.00");
  });

  it("formats token quantities with up to four fraction digits", () => {
    expect(formatQty(30n * 10n ** 18n, 18)).toBe("30");
    expect(formatQty(1_000_001n, 6)).toBe("1");
    expect(formatQty(1_500_000n, 6)).toBe("1.5");
    expect(formatQty(123_456_789n, 9, 4)).toBe("0.1234");
  });

  it("parses decimal strings into base units and refuses too many digits", () => {
    expect(parseDecimal("8.50", 6)).toBe(8_500_000n);
    expect(parseDecimal("8,5", 6)).toBe(8_500_000n);
    expect(parseDecimal("1000", 18)).toBe(1000n * 10n ** 18n);
    expect(parseDecimal("0.0000001", 6)).toBeNull();
    expect(parseDecimal("", 6)).toBeNull();
    expect(parseDecimal("abc", 6)).toBeNull();
    expect(parseDecimal(".5", 6)).toBe(500_000n);
  });

  it("shows the locked fraction at close as a percentage", () => {
    expect(lockedPercent(250_000_000_000_000_000n)).toBe("75.00%");
    expect(lockedPercent(0n)).toBe("100.00%");
  });

  it("computes Create Exit's locked-at-close share with the engine's unlock math (live CINDR class, cliff 0)", () => {
    // engine-s4 class c5b14256…: get_class at block 276204160 (timestamp 1793800797.96 s) returned fraction_now 175108133561643834.
    const cindr = {
      decimals: 18,
      schedule: { kind: "Linear" as const, start: 1_791_169_008n, cliff: 0n, end: 1_822_705_008n, granularity: 1n, startUnlock: 1n, cliffUnlock: 0n, total: 10n, minDeposit: 10n ** 18n },
    };
    const fraction = fractionAt(cindr, 1_793_800_797n);
    expect(fraction).toBe(175_108_133_561_643_834n);
    expect(lockedPercent(fraction)).toBe("82.48%");
  });
});

describe("fee and collateral previews (spec 5.3, 5.5)", () => {
  const pricing = roundPricing({ kind: "Exit", fTs: 0n }, 6);

  it("charges limit × quantity plus 30 bps and bonds max(1 USDC, 1%)", () => {
    const preview = previewBuy(pricing, 15_000_000n, 8_500_000n, null);
    expect(preview.charge).toBe(127_500_000n);
    expect(preview.fee).toBe(382_500n);
    expect(preview.escrowRequired).toBe(127_882_500n);
    expect(preview.bond).toBe(1_278_825n);
    expect(preview.total).toBe(preview.escrowRequired + preview.bond);
  });

  it("uses the chosen escrow when it is above the minimum and the floor bond for small orders", () => {
    const preview = previewBuy(pricing, 1_000_000n, 2_000_000n, 500_000_000n);
    expect(preview.escrowRequired).toBe(2_006_000n);
    expect(preview.bond).toBe(5_000_000n);
    expect(preview.total).toBe(505_000_000n);
    const small = previewBuy(pricing, 1_000_000n, 1_000_000n, null);
    expect(small.bond).toBe(1_000_000n);
  });

  it("applies the locked fraction at close for Exit and none for Advance claims", () => {
    const quarterUnlocked = roundPricing({ kind: "Exit", fTs: 250_000_000_000_000_000n }, 6);
    expect(previewBuy(quarterUnlocked, 100_000_000n, 1_900_000n, null).charge).toBe(142_500_000n);
    expect(roundPricing({ kind: "Advance", fTs: 250_000_000_000_000_000n }, 6)).toEqual(perClaimedToken(6));
    expect(previewBuy(perClaimedToken(6), 50_000_000n, 10_500_000n, null).charge).toBe(525_000_000n);
  });

  it("values a seller's locked units at the max price for the bond", () => {
    const preview = previewSell(pricing, 100_000_000n, 80_000_000n, 1_200_000n, 10_000_000n);
    expect(preview.valuation).toBe(1_000_000_000n);
    expect(preview.bond).toBe(10_000_000n);
    expect(preview.proceedsAtMinimum).toBe(96_000_000n);
    expect(bondFor(50_000_000n)).toBe(1_000_000n);
    expect(bondFor(50_000_000n, 2_000_000n)).toBe(2_000_000n);
  });
});

describe("next action (spec 5.6)", () => {
  it("walks the lifecycle", () => {
    expect(nextAction(round({ status: "Scheduled" }), NOW_MS).kind).toBe("wait_open");
    expect(nextAction(round(), NOW_MS).kind).toBe("bid");
    expect(nextAction(round({ closesAt: msToNs(NOW_MS) - SEC }), NOW_MS).kind).toBe("close");
    const requested = round({ status: "KeyRequested", closesAt: msToNs(NOW_MS) - 10n * SEC, closeRequestedAt: msToNs(NOW_MS) - 5n * SEC });
    expect(nextAction(requested, NOW_MS)).toMatchObject({ kind: "waiting_key" });
    expect(nextAction({ ...requested, closesAt: msToNs(NOW_MS) - 7200n * SEC, closeRequestedAt: msToNs(NOW_MS) - 7000n * SEC }, NOW_MS).kind).toBe("cancel_no_key");
    const revealing = round({ status: "Revealing", key: "bls12381g1:x", revealEndsAt: msToNs(NOW_MS) + 300n * SEC, openedCount: 1 });
    expect(nextAction(revealing, NOW_MS)).toEqual({ kind: "finalize", remaining: 2, until: NOW_MS + 300_000 });
    expect(nextAction({ ...revealing, openedCount: 3 }, NOW_MS).kind).toBe("wait_reveal");
    expect(nextAction(round({ status: "Clearing" }), NOW_MS).kind).toBe("clear");
    expect(nextAction(round({ status: "Settled", settledCount: 1 }), NOW_MS)).toEqual({ kind: "settle", pending: 2 });
    expect(nextAction(round({ status: "Settled", settledCount: 3 }), NOW_MS).kind).toBe("done");
    expect(nextAction(round({ status: "Cancelled", cancelReason: "NoCrossing", settledCount: 0 }), NOW_MS)).toEqual({ kind: "settle", pending: 3 });
  });

  it("offers cancel_no_key, not a close the engine refuses, once an Open round with orders passes its key timeout", () => {
    const pastTimeout = round({ closesAt: msToNs(NOW_MS) - 3601n * SEC });
    expect(nextAction(pastTimeout, NOW_MS).kind).toBe("cancel_no_key");
    expect(canClose(pastTimeout, NOW_MS)).toBe(false);
    expect(canCancelNoKey(pastTimeout, NOW_MS)).toBe(true);
    // Without orders `close` still works after the timeout: it cancels the round (CancelReason::Empty).
    expect(nextAction({ ...pastTimeout, bidCount: 0 }, NOW_MS).kind).toBe("close");
    expect(nextAction(round({ closesAt: msToNs(NOW_MS) - 3599n * SEC }), NOW_MS).kind).toBe("close");
  });

  it("waits for an in-flight key request (250 blocks) before offering cancel_no_key", () => {
    const lateRetry = round({ status: "KeyRequested", closesAt: msToNs(NOW_MS) - 3700n * SEC, closeRequestedAt: msToNs(NOW_MS) - 150n * SEC });
    expect(cancelNoKeyAt(lateRetry)).toBe(lateRetry.closeRequestedAt! + KEY_REQUEST_FLIGHT_NS);
    expect(nextAction(lateRetry, NOW_MS)).toMatchObject({ kind: "waiting_key", cancelAt: NOW_MS + 50_000 });
    expect(canCancelNoKey(lateRetry, NOW_MS)).toBe(false);
    expect(nextAction(lateRetry, NOW_MS + 50_000).kind).toBe("cancel_no_key");
    const early = round({ status: "KeyRequested", closesAt: msToNs(NOW_MS) - 10n * SEC, closeRequestedAt: msToNs(NOW_MS) - 5n * SEC });
    expect(cancelNoKeyAt(early)).toBe(early.closesAt + early.keyTimeout);
  });

  it("lets the creator withdraw only before the first order and the close", () => {
    const empty = round({ bidCount: 0 });
    expect(canCancelAsCreator(empty, "alice.testnet", NOW_MS)).toBe(true);
    expect(canCancelAsCreator(empty, "bob.testnet", NOW_MS)).toBe(false);
    expect(canCancelAsCreator(round(), "alice.testnet", NOW_MS)).toBe(false);
    expect(canCancelAsCreator({ ...empty, closesAt: msToNs(NOW_MS) - SEC }, "alice.testnet", NOW_MS)).toBe(false);
  });

  it("opens the no-key cancellation after closes_at + key_timeout", () => {
    const late = round({ status: "KeyRequested", closesAt: msToNs(NOW_MS) - 4000n * SEC });
    expect(canCancelNoKey(late, NOW_MS)).toBe(true);
    expect(canCancelNoKey({ ...late, key: "bls12381g1:x", status: "Revealing" }, NOW_MS)).toBe(false);
    expect(canCancelNoKey(round({ status: "Open", closesAt: msToNs(NOW_MS) - 4000n * SEC }), NOW_MS)).toBe(true);
  });
});

describe("timeline", () => {
  it("marks the active step and the ones before it as done", () => {
    const steps = timeline(round({ status: "Revealing", key: "k", keySource: "Callback", closeRequestedAt: msToNs(NOW_MS) - 100n * SEC, keyReceivedAt: msToNs(NOW_MS) - 95n * SEC, revealEndsAt: msToNs(NOW_MS) + 500n * SEC }), NOW_MS);
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "active", "upcoming", "upcoming"]);
    expect(steps[1]?.detail).toContain("5.0 s after close");
  });

  it("shows a cancelled round with the failing step", () => {
    const steps = timeline(round({ status: "Cancelled", cancelReason: "NoKey" }), NOW_MS);
    expect(steps.map((s) => s.state)).toEqual(["done", "failed", "upcoming", "upcoming", "upcoming"]);
    expect(steps[1]?.label).toBe("Cancelled");
    const noCrossing = timeline(round({ status: "Cancelled", cancelReason: "NoCrossing" }), NOW_MS);
    expect(noCrossing.map((s) => s.state)).toEqual(["done", "done", "done", "failed", "upcoming"]);
  });

  it("never shows the zero-price record of a cancelled round as a clearing", () => {
    // engine-s4 round 5 (Exit, NoCrossing) and round 4 (NoKey) store price 0, volume 0.
    const zero = { price: 0n, volume: 0n, notional: 0n, fee: 0n, issuerCharged: 0n, issuerRefund: 0n, remainingLockSecs: 0n, fills: [] };
    const noCrossing = round({ status: "Cancelled", cancelReason: "NoCrossing", result: zero });
    expect(clearingOf(noCrossing)).toBeNull();
    expect(timeline(noCrossing, NOW_MS)[3]?.detail).toBe("no price crossed the book");
    const noKey = round({ status: "Cancelled", cancelReason: "NoKey", result: zero });
    expect(clearingOf(noKey)).toBeNull();
    expect(timeline(noKey, NOW_MS)[3]?.detail).toBe("not reached · every order is refunded");
    const settled = round({ status: "Settled", result: { ...zero, price: 25_000n, volume: 15n * 10n ** 21n } });
    expect(clearingOf(settled)?.price).toBe(25_000n);
    expect(timeline(settled, NOW_MS)[3]?.detail).toBe("cleared at 0.025 · volume 15,000");
  });

  it("settled rounds are done end to end", () => {
    const steps = timeline(round({ status: "Settled", settledCount: 3, endedAt: msToNs(NOW_MS) }), NOW_MS);
    expect(steps.every((s) => s.state === "done")).toBe(true);
    expect(steps[4]?.detail).toBe("every order settled");
  });

  it("progress grows with time while open, then with the step", () => {
    expect(roundProgress(round(), NOW_MS)).toBeCloseTo(0.25, 2);
    expect(roundProgress(round({ status: "Settled" }), NOW_MS)).toBe(1);
    expect(roundProgress(round({ status: "KeyRequested" }), NOW_MS)).toBeCloseTo(0.625, 3);
  });
});

describe("pricing helpers", () => {
  it("keeps ONE as the locked fraction when nothing is unlocked", () => {
    expect(roundPricing({ kind: "Tender", fTs: 0n }, 18).lockedFractionE18).toBe(ONE);
  });
});

describe("cancelledOutcome", () => {
  it("names why a cancelled round ended instead of its zero-price record", () => {
    // engine-s4 rounds 3 and 4 (no key) and 5 (no crossing) stored a result with price 0.
    expect(cancelledOutcome(round({ status: "Cancelled", cancelReason: "NoKey" }))).toBe("No key");
    expect(cancelledOutcome(round({ status: "Cancelled", cancelReason: "NoCrossing" }))).toBe("No crossing");
    expect(cancelledOutcome(round({ status: "Cancelled", cancelReason: "Empty" }))).toBe("No orders");
    expect(cancelledOutcome(round({ status: "Cancelled", cancelReason: "Creator" }))).toBe("Withdrawn");
  });
});
