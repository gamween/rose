import { describe, expect, it } from "vitest";

import {
  advance,
  affordable,
  BPS_DENOMINATOR,
  charge,
  ClearingError,
  exit,
  FEE_BPS,
  fee,
  payout,
  perClaimedToken,
  tender,
} from "../src/clearing.js";
import type { Fill, Order, Outcome, Pricing } from "../src/clearing.js";
import { ONE, U128_MAX } from "../src/math.js";
import { loadClearingVectors } from "./vectors.js";
import type { ExpectedFill } from "./vectors.js";

const vectors = loadClearingVectors();

const UNIT: Pricing = { lockedFractionE18: ONE, tokenDecimals: 0 };

function order(id: bigint, qty: bigint, price: bigint): Order {
  return { id, qty, price };
}

function clearingError(run: () => unknown): ClearingError | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ClearingError) {
      return error;
    }
    throw error;
  }
  return undefined;
}

function cleared<T>(outcome: Outcome<T>): T {
  if (outcome.outcome === "no_crossing") {
    throw new Error("expected a crossing");
  }
  return outcome;
}

/** Fills with the buyer's fee alongside, as the vectors record them. */
function withFees(fills: readonly Fill[]): ExpectedFill[] {
  return fills.map((fill) => ({ ...fill, fee: fee(fill.cash) }));
}

function withoutFees(fills: readonly Fill[]): ExpectedFill[] {
  return fills.map((fill) => ({ ...fill, fee: undefined }));
}

describe("clearing vectors", () => {
  it("use the same fee parameters", () => {
    expect(vectors.feeBps).toBe(FEE_BPS);
    expect(vectors.bpsDenominator).toBe(BPS_DENOMINATOR);
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      switch (vector.round) {
        case "tender": {
          const result = tender(vector.input);
          if (result.outcome === "no_crossing") {
            expect(vector.expected).toEqual({ outcome: "no_crossing" });
            return;
          }
          expect({
            outcome: "cleared",
            price: result.price,
            volume: result.volume,
            asks: withoutFees(result.asks),
            charged: result.charged,
            fee: fee(result.charged),
            refund: result.refund,
          }).toEqual(vector.expected);
          return;
        }
        case "exit":
        case "advance": {
          const result = vector.round === "exit" ? exit(vector.input) : advance(vector.input);
          if (result.outcome === "no_crossing") {
            expect(vector.expected).toEqual({ outcome: "no_crossing" });
            return;
          }
          expect({
            outcome: "cleared",
            price: result.price,
            volume: result.volume,
            bids: withFees(result.bids),
            asks: withoutFees(result.asks),
            notional: result.notional,
          }).toEqual(vector.expected);
        }
      }
    });
  }
});

describe("fee", () => {
  it("is thirty bps rounded up", () => {
    expect(fee(0n)).toBe(0n);
    expect(fee(1n)).toBe(1n);
    expect(fee(10_000n)).toBe(30n);
    expect(fee(10_001n)).toBe(31n);
    expect(fee(900n)).toBe(3n);
    expect(fee(U128_MAX)).toBe((U128_MAX * FEE_BPS + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR);
  });
});

describe("pricing", () => {
  it("rounds against the trader", () => {
    const pricing: Pricing = { lockedFractionE18: ONE / 3n, tokenDecimals: 2 };
    expect(charge(pricing, 10n, 100n)).toBe(4n);
    expect(payout(pricing, 10n, 100n)).toBe(3n);
    expect(affordable(pricing, 4n, 100n)).toBe(12n);
    expect(charge(pricing, 12n, 100n)).toBeLessThanOrEqual(4n);
    expect(charge(pricing, 13n, 100n)).toBeGreaterThan(4n);
  });

  it("reduces to qty times price with the identity pricing", () => {
    expect(charge(UNIT, 100n, 9n)).toBe(900n);
    expect(payout(UNIT, 100n, 9n)).toBe(900n);
    expect(affordable(UNIT, 950n, 10n)).toBe(95n);
    expect(affordable(UNIT, 950n, 0n)).toBe(U128_MAX);
    expect(affordable({ lockedFractionE18: 0n, tokenDecimals: 0 }, 950n, 10n)).toBe(U128_MAX);
    expect(perClaimedToken(18)).toEqual({ lockedFractionE18: ONE, tokenDecimals: 18 });
  });

  it("saturates the affordable quantity and overflows the cash", () => {
    const pricing: Pricing = { lockedFractionE18: 1n, tokenDecimals: 38 };
    expect(affordable(pricing, U128_MAX, 1n)).toBe(U128_MAX);
    const overflow = clearingError(() => charge(UNIT, U128_MAX, 2n));
    expect(overflow?.code).toBe("math");
    expect(overflow?.cause).toMatchObject({ code: "overflow" });
  });

  it("rejects invalid pricing", () => {
    const over: Pricing = { lockedFractionE18: ONE + 1n, tokenDecimals: 0 };
    expect(clearingError(() => tender({ asks: [], budget: 1n, maxPrice: 1n, pricing: over }))?.code).toBe(
      "invalid_pricing",
    );
    expect(clearingError(() => exit({ bids: [], asks: [], pricing: perClaimedToken(39) }))?.code).toBe(
      "invalid_pricing",
    );
    expect(clearingError(() => charge(perClaimedToken(39), 1n, 1n))?.code).toBe("invalid_pricing");
    expect(clearingError(() => affordable(perClaimedToken(39), 1n, 1n))?.code).toBe("invalid_pricing");
    expect(() => charge(perClaimedToken(-1), 1n, 1n)).toThrow(RangeError);
    expect(() => charge({ lockedFractionE18: -1n, tokenDecimals: 0 }, 1n, 1n)).toThrow(RangeError);
  });
});

describe("tender", () => {
  it("rejects duplicate ids with the smallest duplicated id", () => {
    const error = clearingError(() =>
      tender({ asks: [order(5n, 1n, 1n), order(1n, 2n, 2n), order(5n, 1n, 1n), order(1n, 1n, 3n)], budget: 10n, maxPrice: 10n, pricing: UNIT }),
    );
    expect(error?.code).toBe("duplicate_order_id");
    expect(error?.orderId).toBe(1n);
    expect(error?.message).toBe("duplicate order id 1");
  });

  it("rejects quantities that overflow", () => {
    const asks = [order(1n, U128_MAX, 5n), order(2n, 1n, 5n)];
    expect(clearingError(() => tender({ asks, budget: 1n, maxPrice: 10n, pricing: UNIT }))?.code).toBe(
      "quantity_overflow",
    );
  });

  it("rejects inputs outside their integer domains", () => {
    expect(() => tender({ asks: [order(1n, 1n, 1n)], budget: -1n, maxPrice: 1n, pricing: UNIT })).toThrow(RangeError);
    expect(() => tender({ asks: [order(-1n, 1n, 1n)], budget: 1n, maxPrice: 1n, pricing: UNIT })).toThrow(RangeError);
  });

  it("handles extreme prices and budgets", () => {
    const result = cleared(tender({ asks: [order(1n, 1n, U128_MAX)], budget: U128_MAX, maxPrice: U128_MAX, pricing: perClaimedToken(0) }));
    expect(result.price).toBe(U128_MAX);
    expect(result.volume).toBe(1n);
    expect(result.charged).toBe(U128_MAX);
    expect(result.refund).toBe(0n);
  });
});

describe("exit and advance", () => {
  it("handle extreme limits", () => {
    const result = cleared(exit({ bids: [order(1n, 1n, U128_MAX)], asks: [order(1n, 1n, U128_MAX)], pricing: perClaimedToken(38) }));
    expect(result.price).toBe(U128_MAX);
    expect(result.volume).toBe(1n);
  });

  it("reject overflowing quantities on either side", () => {
    const bids = [order(1n, 1n, 5n)];
    const asks = [order(1n, U128_MAX, 5n), order(2n, 1n, 6n)];
    expect(clearingError(() => exit({ bids, asks, pricing: UNIT }))?.code).toBe("quantity_overflow");
    expect(clearingError(() => exit({ bids: asks, asks: bids, pricing: UNIT }))?.code).toBe("quantity_overflow");
  });

  it("reject duplicate ids on either side", () => {
    expect(clearingError(() => exit({ bids: [order(1n, 1n, 1n), order(1n, 1n, 1n)], asks: [], pricing: UNIT }))?.code).toBe(
      "duplicate_order_id",
    );
    expect(clearingError(() => exit({ bids: [], asks: [order(2n, 1n, 1n), order(2n, 1n, 1n)], pricing: UNIT }))?.code).toBe(
      "duplicate_order_id",
    );
  });

  it("refuse an advance whose minimum fill exceeds the claim", () => {
    const ask = { id: 7n, claim: 100n, reserve: 10n, minFill: 101n };
    expect(clearingError(() => advance({ ask, bids: [], tokenDecimals: 0 }))?.code).toBe("min_fill_above_claim");
    expect(() => advance({ ask: { ...ask, minFill: -1n }, bids: [], tokenDecimals: 0 })).toThrow(RangeError);
  });

  it("treat a zero minimum fill as one unit", () => {
    const ask = { id: 7n, claim: 100n, reserve: 10n, minFill: 0n };
    expect(advance({ ask, bids: [order(1n, 0n, 12n)], tokenDecimals: 0 })).toEqual({ outcome: "no_crossing" });
    expect(cleared(advance({ ask, bids: [order(1n, 1n, 12n)], tokenDecimals: 0 })).volume).toBe(1n);
  });

  it("report the notional overflow as a quantity overflow", () => {
    const bids = [order(1n, U128_MAX, 2n), order(2n, 1n, 2n)];
    const asks = [order(1n, U128_MAX, 1n)];
    expect(clearingError(() => exit({ bids, asks, pricing: UNIT }))?.code).toBe("quantity_overflow");
  });
});

describe("error messages", () => {
  it("mirror the engine's display strings", () => {
    expect(new ClearingError("quantity_overflow").message).toBe("order quantities overflow");
    expect(new ClearingError("invalid_pricing").message).toBe("invalid pricing parameters");
    expect(new ClearingError("min_fill_above_claim").message).toBe("minimum fill exceeds the claim");
    expect(new ClearingError("budget_exceeded").message).toBe("charge exceeds the budget");
    expect(new ClearingError("math").message).toBe("clearing arithmetic: failure");
    expect(new ClearingError("duplicate_order_id").message).toBe("duplicate order id unknown");
  });
});
