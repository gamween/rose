import { ONE, type ClassInfo, type Holding, type Lien, type LienShare, type PayoutView, type RetiredLot, type StoredEvent } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { accountEvents, claimSourceArgs, holdingRows, lienProgress, orderRows, payoutState, pendingHint, planSolClaim, redeemBlocker, settledPayout, solStreamAttention, solStreamPhase, syncBlocker, tokenClaims } from "./transforms";

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
  return { id: "1", chain: "Base", kind: { BaseTransfer: { token: seed.token, to: "0x1", amount: "1" } }, debit: null, requester: "a.testnet", status: "Signed", created_at: "0", updated_at: "0", requested_block: "100", sign_requests: 1, ...overrides };
}

describe("payoutState", () => {
  it("distinguishes signed, submitted, awaiting gas, stale and failed payouts", () => {
    expect(payoutState(payout({}), "pending", 1000n)).toBe("signed");
    expect(payoutState(payout({}), null, 1000n)).toBe("signed");
    expect(payoutState(payout({}), "executed", 1000n)).toBe("submitted");
    expect(payoutState(payout({ status: "AwaitingGasSignature" }), null, 1000n)).toBe("awaiting_gas");
    expect(payoutState(payout({ status: "Requested" }), null, 500n)).toBe("requested");
    expect(payoutState(payout({ status: "Requested" }), null, 700n)).toBe("stale");
    expect(payoutState(payout({ status: { Failed: { reason: "no signature" } } }), null, 700n)).toBe("failed");
    expect(payoutState(payout({ status: "Landed" }), null, 700n)).toBe("submitted");
    const solTransfer = payout({ chain: "Solana", kind: { SolTransfer: { mint: "m", to_owner: "o", amount: "1" } } });
    expect(payoutState(solTransfer, "executed", 700n)).toBe("unconfirmed");
    expect(payoutState(solTransfer, "pending", 700n)).toBe("signed");
  });

  it("settles deposit moves and returns from the chain: executed, or lapsed once their blockhash expired (never a broadcast button)", () => {
    const move = payout({ chain: "Solana", kind: { SolMove: { metadata: "m", from: "f", to_owner: "o" } } });
    const ret = payout({ chain: "Solana", kind: { SolReturn: { metadata: "m", from: "f", to_owner: "o" } } });
    expect(payoutState(move, "executed", 700n)).toBe("submitted");
    expect(payoutState(ret, "executed", 700n)).toBe("submitted");
    expect(payoutState(move, "lapsed", 700n)).toBe("lapsed");
    expect(payoutState(ret, "pending", 700n)).toBe("signed");
    expect(["submitted", "failed", "lapsed"].every((state) => settledPayout(state as "submitted"))).toBe(true);
    expect(["requested", "stale", "signed", "unconfirmed", "awaiting_gas"].some((state) => settledPayout(state as "signed"))).toBe(false);
  });

  it("explains when a pending payout's next action opens", () => {
    expect(pendingHint(payout({ status: "Requested", requested_block: "1000" }), "requested", 1100n)).toContain('"Retry signature" opens at block 1600 (in about 5 min)');
    const solTransfer = payout({ chain: "Solana", kind: { SolTransfer: { mint: "m", to_owner: "o", amount: "1" } }, solana: { message: "", draws: [], swept: "0", authority_path: "vault/sol", authority: "v", cancel: false, not_executed_seen_at: "5000" } });
    expect(pendingHint(solTransfer, "unconfirmed", 5010n)).toContain("A second proof requested from block 5150 settles it");
    expect(pendingHint({ ...solTransfer, solana: { ...solTransfer.solana!, not_executed_seen_at: null } }, "unconfirmed", 5010n)).toContain("Confirm asks the MPC");
    expect(pendingHint(payout({}), "signed", 1n)).toBeNull();
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

describe("redeemBlocker", () => {
  it("needs the allocation in free units, and on Solana the stream's owed share in claimable tokens", () => {
    expect(redeemBlocker({ allocation: 10n }, 9n, null)).toBe("Your free units do not cover this position's allocation");
    expect(redeemBlocker({ allocation: 10n }, 10n, null)).toBeUndefined();
    expect(redeemBlocker({ allocation: 10n }, 10n, { owed: 6n, claimable: 5n })).toBe("Your claimable tokens do not cover what the stream owes the unit holders");
    expect(redeemBlocker({ allocation: 10n }, 10n, { owed: 5n, claimable: 5n })).toBeUndefined();
  });
});

describe("planSolClaim", () => {
  const entry = (position_id: string, withdrawable: string, net = 1_000, withdrawn = 0) => ({ position_id, withdrawable, stream: { net_amount_deposited: String(net), engine_withdrawn: String(withdrawn) } });
  const streams = [entry("1", "40"), entry("2", "100"), entry("3", "0")];
  it("draws on the largest withdrawable streams first, exactly the claimed amount", () => {
    expect(planSolClaim(streams, 0n, 120n, 1)).toEqual({
      draws: [
        { position_id: "2", amount: "100" },
        { position_id: "1", amount: "20" },
      ],
      swept: 0n,
    });
    expect(planSolClaim(streams, 0n, 50n, 1)).toEqual({ draws: [{ position_id: "2", amount: "50" }], swept: 0n });
  });
  it("never draws less than one whole token unless the draw empties the stream", () => {
    expect(() => planSolClaim([entry("1", "5")], 0n, 5n, 1)).toThrow("at least one whole token");
    expect(planSolClaim([entry("1", "5", 1_000, 995)], 0n, 5n, 1)).toEqual({ draws: [{ position_id: "1", amount: "5" }], swept: 0n });
  });
  it("pays a sub-token claim from a small stream it empties when the largest stream's whole-token minimum exceeds it", () => {
    const small = [entry("A", "50"), entry("B", "3", 1_000, 997)];
    expect(planSolClaim(small, 0n, 3n, 1)).toEqual({ draws: [{ position_id: "B", amount: "3" }], swept: 0n });
    expect(planSolClaim(small, 2n, 5n, 1)).toEqual({ draws: [{ position_id: "B", amount: "3" }], swept: 2n });
    expect(() => planSolClaim(small, 0n, 2n, 1)).toThrow("cannot pay this amount right now");
  });
  it("leaves a whole token for the next stream instead of refusing a feasible split", () => {
    expect(planSolClaim([entry("A", "120"), entry("B", "50")], 0n, 123n, 1).draws).toEqual([
      { position_id: "A", amount: "113" },
      { position_id: "B", amount: "10" },
    ]);
  });
  it("refuses an amount the streams and the swept balance cannot pay now", () => {
    expect(() => planSolClaim(streams, 0n, 141n, 1)).toThrow("cannot pay this amount right now");
    expect(() => planSolClaim(streams, 1n, 142n, 1)).toThrow("sync an ended stream");
  });
  it("pays from the swept balance alone when it covers the claim, with no stream touched", () => {
    expect(planSolClaim(streams, 500n, 120n, 1)).toEqual({ draws: [], swept: 120n });
    expect(planSolClaim([], 7n, 7n, 6)).toEqual({ draws: [], swept: 7n });
  });
  it("takes the swept balance first and draws the rest", () => {
    expect(planSolClaim(streams, 30n, 120n, 1)).toEqual({ draws: [{ position_id: "2", amount: "90" }], swept: 30n });
    expect(planSolClaim(streams, 1n, 141n, 1)).toEqual({
      draws: [
        { position_id: "2", amount: "100" },
        { position_id: "1", amount: "40" },
      ],
      swept: 1n,
    });
  });
  it("draws a whole token and takes less of the swept balance when the rest is below one token", () => {
    expect(planSolClaim([entry("1", "40")], 25n, 28n, 1)).toEqual({ draws: [{ position_id: "1", amount: "10" }], swept: 18n });
    expect(() => planSolClaim([entry("1", "40")], 2n, 8n, 1)).toThrow("cannot pay this amount right now");
  });
});

describe("Solana stream phases and sync", () => {
  const end = Number(NOW + 3_600n);
  it("closes draws 5 minutes before the end, as the engine does (now + 300 < end_time)", () => {
    expect(solStreamPhase({ end_time: end }, NOW)).toBe("open");
    expect(solStreamPhase({ end_time: end }, BigInt(end) - 301n)).toBe("open");
    expect(solStreamPhase({ end_time: end }, BigInt(end) - 300n)).toBe("closing");
    expect(solStreamPhase({ end_time: end, drawing: "7" }, NOW)).toBe("drawing");
    expect(solStreamPhase({ end_time: end, drawing: "7" }, BigInt(end))).toBe("ended");
    expect(solStreamPhase({ end_time: end }, BigInt(end) + 1n)).toBe("ended");
  });
  it("refuses a sync while a payout draws on the stream, or with nothing withdrawn beyond the engine's accounting", () => {
    expect(syncBlocker({ engine_withdrawn: "100", drawing: "12" }, 1_000n)).toContain("Payout #12 draws on this stream and is not confirmed yet");
    expect(syncBlocker({ engine_withdrawn: "100" }, null)).toContain("could not be read");
    expect(syncBlocker({ engine_withdrawn: "100" }, 100n)).toContain("Nothing to sync yet");
    expect(syncBlocker({ engine_withdrawn: "100", drawing: null }, 1_000n)).toBeUndefined();
  });
  it("flags an open stream that withdraws automatically or withdrew beyond the engine's accounting, never one a payout draws on", () => {
    const row = (phase: "open" | "drawing" | "closing" | "ended", onChainWithdrawn: bigint | null, automaticWithdrawal: boolean | null) => ({ phase, entry: { stream: { engine_withdrawn: "100" } }, onChainWithdrawn, automaticWithdrawal });
    expect(solStreamAttention(row("open", 100n, false))).toBeNull();
    expect(solStreamAttention(row("open", 400n, false))).toEqual({ kind: "sync_required", unbooked: 300n });
    expect(solStreamAttention(row("closing", 400n, false))).toEqual({ kind: "sync_required", unbooked: 300n });
    expect(solStreamAttention(row("open", 100n, true))).toEqual({ kind: "automatic_withdrawal", unbooked: 0n });
    expect(solStreamAttention(row("open", 400n, true))).toEqual({ kind: "automatic_withdrawal", unbooked: 300n });
    expect(solStreamAttention(row("drawing", 400n, true))).toBeNull();
    expect(solStreamAttention(row("ended", 400n, false))).toBeNull();
    expect(solStreamAttention(row("open", null, null))).toBeNull();
  });
});
