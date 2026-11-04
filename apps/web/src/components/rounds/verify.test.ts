import type { Bid, BidOutcome, Round } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { verifyRound } from "./verify";

const U = (n: number) => BigInt(n) * 1_000_000n;

function bid(bidId: number, side: "Buy" | "Sell", quantity: bigint, price: bigint, extra: Partial<Bid> = {}): Bid {
  return {
    roundId: 1n,
    bidId,
    bidder: `b${String(bidId)}.testnet`,
    side,
    status: "Settled",
    escrow: side === "Buy" ? U(1000) : 0n,
    lockedUnits: side === "Sell" ? quantity : 0n,
    bond: U(1),
    fee: 0n,
    cash: 0n,
    fillQuantity: 0n,
    ciphertextHex: null,
    placedAt: null,
    opened: { quantity, price },
    void: null,
    ...extra,
  };
}

function outcome(bidId: number, side: "Buy" | "Sell", fillQuantity: bigint, cash: bigint, opened: { quantity: bigint; price: bigint }): BidOutcome {
  return { bidId, bidder: `b${String(bidId)}.testnet`, side, escrow: 0n, lockedUnits: 0n, bond: U(1), fee: 0n, cash, fillQuantity, settled: true, opened, void: null };
}

function base(overrides: Partial<Round>): Round {
  return {
    roundId: 1n,
    kind: "Exit",
    classId: "a".repeat(64),
    venue: "Near",
    creator: "alice.testnet",
    status: "Settled",
    appId: "b".repeat(64),
    opensAt: 0n,
    closesAt: 1n,
    keyTimeout: 1n,
    revealWindow: 1n,
    maxPrice: U(20),
    fTs: 0n,
    remainingLockSecs: 0n,
    bidCount: 0,
    openedCount: 0,
    settledCount: 0,
    createdAt: 0n,
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

describe("verifyRound", () => {
  it("matches the on-chain result of clearing example 4 (midpoint tie, rationed long side)", () => {
    const bids = [bid(0, "Buy", U(10), U(15)), bid(1, "Buy", U(10), U(12)), bid(2, "Sell", U(15), U(5))];
    const fills = [outcome(0, "Buy", U(10), U(85), { quantity: U(10), price: U(15) }), outcome(1, "Buy", U(5), 42_500_000n, { quantity: U(10), price: U(12) }), outcome(2, "Sell", U(15), 127_500_000n, { quantity: U(15), price: U(5) })];
    const round = base({ bidCount: 3, openedCount: 3, settledCount: 3, result: { price: 8_500_000n, volume: U(15), notional: 127_500_000n, fee: 382_500n, issuerCharged: 0n, issuerRefund: 0n, remainingLockSecs: 0n, fills } });
    const verification = verifyRound(round, 6, bids);
    expect(verification.status).toBe("match");
    expect(verification.local?.price).toBe(8_500_000n);
    expect(verification.differences).toEqual([]);
  });

  it("reports a mismatch when the chain stored another price or fill", () => {
    const bids = [bid(0, "Buy", U(10), U(10)), bid(1, "Buy", U(5), U(8)), bid(2, "Sell", U(10), U(6))];
    const fills = [outcome(0, "Buy", U(10), U(95), { quantity: U(10), price: U(10) }), outcome(2, "Sell", U(10), U(95), { quantity: U(10), price: U(6) })];
    const round = base({ bidCount: 3, openedCount: 3, result: { price: 9_500_000n, volume: U(10), notional: U(95), fee: 285_000n, issuerCharged: 0n, issuerRefund: 0n, remainingLockSecs: 0n, fills } });
    const verification = verifyRound(round, 6, bids);
    expect(verification.status).toBe("mismatch");
    expect(verification.local?.price).toBe(U(9));
    expect(verification.differences[0]).toContain("Clearing price");
  });

  it("recomputes a Tender with a rationed marginal level (example 2, whole units)", () => {
    const bids = [bid(0, "Sell", 30n, U(5)), bid(1, "Sell", 40n, U(8)), bid(2, "Sell", 20n, U(8))];
    const fills = [outcome(0, "Sell", 30n, U(240), { quantity: 30n, price: U(5) }), outcome(1, "Sell", 13n, U(104), { quantity: 40n, price: U(8) }), outcome(2, "Sell", 7n, U(56), { quantity: 20n, price: U(8) })];
    const round = base({ kind: "Tender", budget: U(400), maxPrice: U(10), bidCount: 3, openedCount: 3, result: { price: U(8), volume: 50n, notional: U(400), fee: 1_200_000n, issuerCharged: U(400), issuerRefund: 0n, remainingLockSecs: 0n, fills } });
    const verification = verifyRound(round, 0, bids);
    expect(verification.differences).toEqual([]);
    expect(verification.status).toBe("match");
  });

  it("recomputes an Advance partial fill (example 6)", () => {
    const bids = [bid(0, "Sell", U(100), U(10)), bid(1, "Buy", U(30), U(12)), bid(2, "Buy", U(20), U(11))];
    const fills = [outcome(1, "Buy", U(30), U(315), { quantity: U(30), price: U(12) }), outcome(2, "Buy", U(20), U(210), { quantity: U(20), price: U(11) }), outcome(0, "Sell", U(50), U(525), { quantity: U(100), price: U(10) })];
    const round = base({ kind: "Advance", advanceClaim: U(100), advanceMinFill: U(40), advanceUnits: U(200), bidCount: 3, openedCount: 3, result: { price: 10_500_000n, volume: U(50), notional: U(525), fee: 1_575_000n, issuerCharged: 0n, issuerRefund: 0n, remainingLockSecs: 0n, fills } });
    const verification = verifyRound(round, 6, bids);
    expect(verification.status).toBe("match");
    expect(verification.local?.volume).toBe(U(50));
  });

  it("agrees with a no-crossing cancellation and reports a book that is still sealed", () => {
    const bids = [bid(0, "Buy", U(10), U(5)), bid(1, "Sell", U(10), U(8))];
    const cancelled = base({ status: "Cancelled", cancelReason: "NoCrossing", bidCount: 2, openedCount: 2 });
    expect(verifyRound(cancelled, 6, bids).status).toBe("match");
    expect(verifyRound(base({ status: "Revealing" }), 6, bids).status).toBe("pending");
    const sealed = [bid(0, "Buy", U(10), U(5)), { ...bid(1, "Sell", U(10), U(8)), opened: null, status: "Sealed" as const }];
    expect(verifyRound(base({ status: "Settled", result: { price: U(5), volume: 0n, notional: 0n, fee: 0n, issuerCharged: 0n, issuerRefund: 0n, remainingLockSecs: 0n, fills: [] } }), 6, sealed).status).toBe("incomplete");
  });
});
