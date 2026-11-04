import { ONE, type ClassInfo, type Holding, type Lien, type LienShare, type PayoutView, type RetiredLot, type StoredEvent } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { accountEvents, actionablePayouts, claimSourceArgs, holdingRows, lienProgress, orderRows, payoutState, tokenClaims } from "./transforms";

const NOW = 1_762_200_000n;
const DAY = 86_400n;

const seed: ClassInfo = {
  classId: "a".repeat(64),
  chain: "Base",
  token: "0x4444444444444444444444444444444444444444",
  tokenRisk: "",
  decimals: 18,
  schedule: { kind: "Linear", start: NOW - 90n * DAY, cliff: NOW - 60n * DAY, end: NOW + 275n * DAY, granularity: 1n, total: 10n, startUnlock: 0n, cliffUnlock: 1n, minDeposit: 10n ** 18n },
  totalUnits: 400n * 10n ** 18n,
  positions: 4,
  createdAt: 0n,
  fractionNow: 0n,
};

const strategic: ClassInfo = {
  ...seed,
  classId: "c".repeat(64),
  chain: "Solana",
  token: "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w",
  decimals: 9,
  schedule: { kind: "Stepped", start: NOW - 60n * DAY, end: NOW + 305n * DAY, period: DAY, amountPerPeriod: 1n, cliffAmount: 0n, total: 365n },
};

const classes = new Map([
  [seed.classId, seed],
  [strategic.classId, strategic],
]);

function holding(overrides: Partial<Holding>): Holding {
  return { classId: seed.classId, balance: 0n, lockedInRounds: 0n, encumbered: 0n, claimable: 0n, checkpoint: 0n, ...overrides };
}

describe("holdingRows", () => {
  it("values every unit held at f(now) and drops empty rows", () => {
    const rows = holdingRows([holding({ balance: 70n * 10n ** 18n, lockedInRounds: 20n * 10n ** 18n, encumbered: 10n * 10n ** 18n, claimable: 5n }), holding({ classId: strategic.classId })], classes, NOW);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.totalUnits).toBe(100n * 10n ** 18n);
    expect(row.fractionNow).toBeGreaterThan(0n);
    expect(row.fractionNow).toBeLessThan(ONE);
    expect(row.lockedTokens + row.unlockedTokens).toBeLessThanOrEqual(row.totalUnits);
    expect(row.lockedTokens + row.unlockedTokens).toBeGreaterThanOrEqual(row.totalUnits - 1n);
  });
});

describe("tokenClaims", () => {
  it("groups claimable amounts by chain with their engine claim source", () => {
    const shares: LienShare[] = [{ lienId: 3n, classId: strategic.classId, funder: "f.testnet", claim: 10n, claimed: 2n, claimable: 4n }];
    const lots: RetiredLot[] = [{ roundId: 7n, classId: seed.classId, retireTo: "0x000000000000000000000000000000000000dead", units: 5n, claimable: 9n }];
    const claims = tokenClaims([holding({ claimable: 12n }), holding({ classId: strategic.classId, claimable: 0n })], shares, lots, classes);
    expect(claims.base.map((claim) => claim.source.kind)).toEqual(["holding", "retired"]);
    expect(claims.solana.map((claim) => claim.source.kind)).toEqual(["lienShare"]);
    expect(claimSourceArgs(claims.base[0]!.source)).toEqual({ Holding: { class_id: seed.classId } });
    expect(claimSourceArgs(claims.base[1]!.source)).toEqual({ Retired: { round_id: "7" } });
    expect(claimSourceArgs(claims.solana[0]!.source)).toEqual({ LienShare: { lien_id: "3" } });
  });
});

function payout(overrides: Partial<PayoutView>): PayoutView {
  return { id: "1", chain: "Base", kind: { BaseTransfer: { token: seed.token, to: "0x1", amount: "1" } }, debit: null, requester: "a.testnet", status: "Signed", created_at: "0", updated_at: "0", requested_block: "100", ...overrides };
}

describe("payoutState", () => {
  it("distinguishes signed, submitted, awaiting gas, stale and failed payouts", () => {
    expect(payoutState(payout({}), false, 1000n)).toBe("signed");
    expect(payoutState(payout({}), true, 1000n)).toBe("submitted");
    expect(payoutState(payout({ status: "AwaitingGasSignature" }), null, 1000n)).toBe("awaiting_gas");
    expect(payoutState(payout({ status: "Requested" }), null, 500n)).toBe("requested");
    expect(payoutState(payout({ status: "Requested" }), null, 700n)).toBe("stale");
    expect(payoutState(payout({ status: { Failed: { reason: "no signature" } } }), null, 700n)).toBe("failed");
    const entries = [
      { payout: payout({ id: "1" }), state: "signed" as const },
      { payout: payout({ id: "2" }), state: "submitted" as const },
      { payout: payout({ id: "3" }), state: "stale" as const },
    ];
    expect(actionablePayouts(entries).map((entry) => entry.payout.id)).toEqual(["1", "3"]);
  });
});

describe("orders, liens and history", () => {
  it("lists live orders first", () => {
    const base = { bidId: 0, bidder: "a.testnet", side: "Buy" as const, escrow: 1n, lockedUnits: 0n, bond: 1n, fee: 0n, cash: 0n, fillQuantity: 0n, ciphertextHex: null, placedAt: null, opened: null, void: null };
    const rows = orderRows([
      { ...base, roundId: 1n, status: "Settled" },
      { ...base, roundId: 2n, status: "Sealed" },
    ]);
    expect(rows.map((row) => row.bid.roundId)).toEqual([2n, 1n]);
    expect(rows[0]!.open).toBe(true);
  });
  it("computes lien delivery progress", () => {
    const lien: Lien = { lienId: 1n, roundId: 2n, classId: seed.classId, holder: "h.testnet", units: 100n, claimTotal: 40n, delivered: 30n, pendingExcess: 0n, createdAt: 0n, released: false };
    const [progress] = lienProgress([lien]);
    expect(progress!.remaining).toBe(10n);
    expect(progress!.percentDelivered).toBe(75);
    expect(progress!.releasable).toBe(false);
    expect(lienProgress([{ ...lien, delivered: 40n }])[0]!.releasable).toBe(true);
  });
  it("keeps the events that mention the account, newest first", () => {
    const events: StoredEvent[] = [
      { seq: 1n, blockHeight: 1n, timestamp: 1n, predecessor: "b.testnet", event: { event: "units_minted", data: { class_id: seed.classId, account: "a.testnet", units: "5" } } },
      { seq: 2n, blockHeight: 2n, timestamp: 2n, predecessor: "a.testnet", event: { event: "round_created", data: { round_id: "1", kind: "Exit", class_id: seed.classId, venue: "Near", creator: "a.testnet", opens_at: "0", closes_at: "0", max_price: "0" } } },
      { seq: 3n, blockHeight: 3n, timestamp: 3n, predecessor: "c.testnet", event: { event: "key_requested", data: { round_id: "1" } } },
    ];
    expect(accountEvents(events, "a.testnet").map((entry) => entry.seq)).toEqual([2n, 1n]);
  });
});
