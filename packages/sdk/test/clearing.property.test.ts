import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { advance, charge, exit, payout, tender } from "../src/clearing.js";
import type { Fill, Order, Pricing, TenderClearing, UniformClearing } from "../src/clearing.js";
import { ONE, U128_MAX } from "../src/math.js";

const UNIT: Pricing = { lockedFractionE18: ONE, tokenDecimals: 0 };
const MAX_PRICE = 14n;
const IDS = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];

const book = fc
  .array(fc.record({ qty: fc.bigInt({ min: 0n, max: 40n }), price: fc.bigInt({ min: 0n, max: MAX_PRICE }) }), {
    maxLength: 8,
  })
  .chain((orders) =>
    fc
      .shuffledSubarray(IDS, { minLength: orders.length, maxLength: orders.length })
      .map((ids) => orders.map((order, i): Order => ({ id: at(ids, i), ...order }))),
  );

const lockedFraction = fc.bigInt({ min: 1n, max: ONE });

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`index ${String(index)} out of bounds`);
  }
  return item;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

/** Quantity asked at or below `price`. */
function supplyAt(asks: readonly Order[], price: bigint): bigint {
  return sum(asks.filter((ask) => ask.price <= price).map((ask) => ask.qty));
}

/** Quantity bid at or above `price`. */
function demandAt(bids: readonly Order[], price: bigint): bigint {
  return sum(bids.filter((bid) => bid.price >= price).map((bid) => bid.qty));
}

/**
 * Tender clearing by scanning every tick from `0` to `maxPrice` with the identity pricing:
 * `Q(P) = min(S(P), floor(budget / P))`, argmax ties to the lowest tick.
 */
function bruteTender(asks: readonly Order[], budget: bigint, maxPrice: bigint): { price: bigint; volume: bigint } | undefined {
  let best: { price: bigint; volume: bigint } | undefined;
  for (let price = 0n; price <= maxPrice; price += 1n) {
    const affordableQty = price === 0n ? U128_MAX : budget / price;
    const volume = min(supplyAt(asks, price), affordableQty);
    if (best === undefined || volume > best.volume) {
      best = { price, volume };
    }
  }
  return best !== undefined && best.volume > 0n ? best : undefined;
}

/**
 * Exit clearing by scanning every tick from `0` to the highest bid limit plus one: maximize
 * `V(P) = min(D(P), S(P))`, then minimize `|D - S|`, then take the midpoint of the tied ticks.
 */
function bruteExit(bids: readonly Order[], asks: readonly Order[]): { price: bigint; volume: bigint } | undefined {
  let best: { volume: bigint; gap: bigint; ticks: bigint[] } | undefined;
  for (let price = 0n; price <= MAX_PRICE + 1n; price += 1n) {
    const demand = demandAt(bids, price);
    const supply = supplyAt(asks, price);
    const volume = min(demand, supply);
    const gap = abs(demand - supply);
    if (best === undefined || volume > best.volume || (volume === best.volume && gap < best.gap)) {
      best = { volume, gap, ticks: [price] };
    } else if (volume === best.volume && gap === best.gap) {
      best.ticks.push(price);
    }
  }
  if (best === undefined || best.volume === 0n) {
    return undefined;
  }
  const low = at(best.ticks, 0);
  const high = at(best.ticks, best.ticks.length - 1);
  // The tied ticks form one interval: D is non-increasing and S non-decreasing in the price.
  expect(high - low + 1n).toBe(BigInt(best.ticks.length));
  return { price: low + (high - low) / 2n, volume: best.volume };
}

/**
 * Checks one side's fills against the fill rule: only eligible orders fill, no fill exceeds its
 * order, the fills sum to `volume`, a level only fills once every better level is full, and the
 * marginal level is rationed by largest remainder with ties to the lower id.
 */
function checkSide(
  orders: readonly Order[],
  fills: readonly Fill[],
  volume: bigint,
  eligible: (order: Order) => boolean,
  better: (a: bigint, b: bigint) => boolean,
): void {
  expect(fills.map((fill) => fill.id)).toEqual(orders.map((order) => order.id));
  for (const [i, fill] of fills.entries()) {
    const order = at(orders, i);
    expect(fill.qty).toBeLessThanOrEqual(order.qty);
    if (!eligible(order)) {
      expect(fill.qty).toBe(0n);
    }
  }
  expect(sum(fills.map((fill) => fill.qty))).toBe(volume);

  const levels = [...new Set(orders.filter(eligible).map((order) => order.price))].sort((a, b) =>
    better(a, b) ? -1 : better(b, a) ? 1 : 0,
  );
  let remaining = volume;
  for (const price of levels) {
    const level = orders
      .map((order, i) => ({ order, fill: at(fills, i) }))
      .filter(({ order }) => order.price === price && order.qty > 0n);
    const levelQty = sum(level.map(({ order }) => order.qty));
    if (levelQty <= remaining) {
      for (const { order, fill } of level) {
        expect(fill.qty).toBe(order.qty);
      }
      remaining -= levelQty;
      continue;
    }
    const shares = level.map(({ order, fill }) => ({
      id: order.id,
      fill: fill.qty,
      floor: (remaining * order.qty) / levelQty,
      remainder: (remaining * order.qty) % levelQty,
    }));
    const ranked = [...shares].sort((a, b) =>
      a.remainder !== b.remainder ? (a.remainder > b.remainder ? -1 : 1) : a.id < b.id ? -1 : 1,
    );
    const leftover = Number(remaining - sum(shares.map((share) => share.floor)));
    for (const [rank, share] of ranked.entries()) {
      expect(share.fill, `order ${share.id.toString()} at rank ${String(rank)}`).toBe(
        share.floor + (rank < leftover ? 1n : 0n),
      );
    }
    remaining = 0n;
  }
  expect(remaining).toBe(0n);
}

function checkUniform(result: UniformClearing, bids: readonly Order[], asks: readonly Order[], pricing: Pricing): void {
  const { price, volume } = result;
  checkSide(bids, result.bids, volume, (bid) => bid.price >= price, (a, b) => a > b);
  checkSide(asks, result.asks, volume, (ask) => ask.price <= price, (a, b) => a < b);
  for (const fill of result.bids) {
    expect(fill.cash).toBe(charge(pricing, fill.qty, price));
  }
  for (const fill of result.asks) {
    expect(fill.cash).toBe(payout(pricing, fill.qty, price));
  }
  expect(result.notional).toBe(sum(result.bids.map((fill) => fill.cash)));
  expect(sum(result.asks.map((fill) => fill.cash))).toBeLessThanOrEqual(result.notional);
}

function checkTender(result: TenderClearing, asks: readonly Order[], budget: bigint, maxPrice: bigint, pricing: Pricing): void {
  const { price, volume } = result;
  expect(price).toBeLessThanOrEqual(maxPrice);
  checkSide(asks, result.asks, volume, (ask) => ask.price <= price, (a, b) => a < b);
  for (const fill of result.asks) {
    expect(fill.cash).toBe(payout(pricing, fill.qty, price));
  }
  expect(result.charged).toBe(charge(pricing, volume, price));
  expect(result.charged).toBeLessThanOrEqual(budget);
  expect(result.refund).toBe(budget - result.charged);
  expect(sum(result.asks.map((fill) => fill.cash))).toBeLessThanOrEqual(result.charged);
}

describe("tender", () => {
  it("matches a brute-force tick scan", () => {
    fc.assert(
      fc.property(book, fc.bigInt({ min: 0n, max: 800n }), fc.bigInt({ min: 0n, max: MAX_PRICE }), (asks, budget, maxPrice) => {
        const expected = bruteTender(asks, budget, maxPrice);
        const result = tender({ asks, budget, maxPrice, pricing: UNIT });
        if (expected === undefined) {
          expect(result).toEqual({ outcome: "no_crossing" });
          return;
        }
        if (result.outcome === "no_crossing") {
          throw new Error("expected a crossing");
        }
        expect({ price: result.price, volume: result.volume }).toEqual(expected);
        checkTender(result, asks, budget, maxPrice, UNIT);
      }),
      { numRuns: 500 },
    );
  });

  it("keeps the fill rule and the budget under any locked fraction", () => {
    fc.assert(
      fc.property(
        book,
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.bigInt({ min: 0n, max: MAX_PRICE }),
        lockedFraction,
        fc.integer({ min: 0, max: 3 }),
        (asks, budget, maxPrice, lockedFractionE18, tokenDecimals) => {
          const pricing: Pricing = { lockedFractionE18, tokenDecimals };
          const result = tender({ asks, budget, maxPrice, pricing });
          if (result.outcome === "cleared") {
            checkTender(result, asks, budget, maxPrice, pricing);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("exit", () => {
  it("matches a brute-force tick scan", () => {
    fc.assert(
      fc.property(book, book, (bids, asks) => {
        const expected = bruteExit(bids, asks);
        const result = exit({ bids, asks, pricing: UNIT });
        if (expected === undefined) {
          expect(result).toEqual({ outcome: "no_crossing" });
          return;
        }
        if (result.outcome === "no_crossing") {
          throw new Error("expected a crossing");
        }
        expect({ price: result.price, volume: result.volume }).toEqual(expected);
        checkUniform(result, bids, asks, UNIT);
      }),
      { numRuns: 500 },
    );
  });

  it("keeps the fill rule and the rounding under any locked fraction", () => {
    fc.assert(
      fc.property(book, book, lockedFraction, fc.integer({ min: 0, max: 3 }), (bids, asks, lockedFractionE18, tokenDecimals) => {
        const pricing: Pricing = { lockedFractionE18, tokenDecimals };
        const result = exit({ bids, asks, pricing });
        const expected = bruteExit(bids, asks);
        expect(result.outcome).toBe(expected === undefined ? "no_crossing" : "cleared");
        if (result.outcome === "cleared") {
          checkUniform(result, bids, asks, pricing);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("advance", () => {
  it("is an exit against one ask with a minimum volume", () => {
    fc.assert(
      fc.property(
        book,
        fc.bigInt({ min: 1n, max: 120n }),
        fc.bigInt({ min: 0n, max: MAX_PRICE }),
        fc.bigInt({ min: 0n, max: 120n }),
        (bids, claim, reserve, minFillSeed) => {
          const minFill = minFillSeed < claim ? minFillSeed : claim;
          const ask = { id: 1n, claim, reserve, minFill };
          const asks: Order[] = [{ id: ask.id, qty: claim, price: reserve }];
          const expected = bruteExit(bids, asks);
          const result = advance({ ask, bids, tokenDecimals: 0 });
          if (expected === undefined || expected.volume < (minFill > 1n ? minFill : 1n)) {
            expect(result).toEqual({ outcome: "no_crossing" });
            return;
          }
          if (result.outcome === "no_crossing") {
            throw new Error("expected a crossing");
          }
          expect({ price: result.price, volume: result.volume }).toEqual(expected);
          checkUniform(result, bids, asks, UNIT);
          expect(result).toEqual(exit({ bids, asks, pricing: UNIT }));
        },
      ),
      { numRuns: 500 },
    );
  });
});
