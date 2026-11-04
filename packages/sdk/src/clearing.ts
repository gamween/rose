/**
 * Uniform-price sealed-bid clearing for the three round types (spec section 5.4): a port of
 * `contracts/engine/src/clearing/`. This is the clearing reference the app's "Verify" panel runs
 * in the browser to recompute a round from its opened bids; it matches the engine bit for bit and
 * is held to it by the JSON vectors in `contracts/engine/tests/vectors/clearing.json`.
 *
 * # Units and money
 *
 * - Quantities are `u128` units: one unit is a claim on one token base unit of the class
 *   schedule. In an Advance, quantities are claimed token base units.
 * - Prices are `u128` cash base units (USDC, 6 decimals: one tick is `1e-6` USDC) per whole
 *   locked token at the settlement time `ts`.
 * - {@link Pricing} converts: the cash for `q` units at price `P` is
 *   `q * lockedFraction * P / (ONE * 10^decimals)`. Buyers are charged that amount rounded up,
 *   sellers are paid it rounded down, so dust stays in the pool.
 *
 * # Determinism
 *
 * Orders are processed in a fixed total order (price priority, then ascending id); rationing uses
 * the largest remainder method with ties to the lower id. Order ids must be unique per side.
 *
 * @module
 */

import {
  assertU128,
  assertU64,
  MathError,
  mulDivCeil,
  mulDivRem,
  mulDivWide,
  ONE,
  pow10,
  U128_MAX,
} from "./math.js";

/**
 * Protocol fee in basis points of settled notional, charged to the buying side on top of the
 * price (spec section 5.5).
 */
export const FEE_BPS = 30n;

/** Basis points in one. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * Fee owed on a settled notional: `ceil(notional * FEE_BPS / BPS_DENOMINATOR)`.
 *
 * @throws {RangeError} When `notional` is not a `u128`.
 */
export function fee(notional: bigint): bigint {
  return mulDivCeil(notional, FEE_BPS, BPS_DENOMINATOR);
}

/** One opened bid or ask. */
export interface Order {
  /** Identifier (`u64`), unique on its side of the book. */
  readonly id: bigint;
  /** Quantity in units (claimed token base units in an Advance). */
  readonly qty: bigint;
  /** Limit price (bid) or minimum price (ask) per whole token. */
  readonly price: bigint;
}

/** Fill of one order. */
export interface Fill {
  /** Order id. */
  readonly id: bigint;
  /** Filled quantity. */
  readonly qty: bigint;
  /** Cash charged to a buyer (rounded up) or paid to a seller (rounded down), fees excluded. */
  readonly cash: bigint;
}

/** A round that no price crosses: it is cancelled and everything is refunded. */
export interface NoCrossing {
  /** Discriminant. */
  readonly outcome: "no_crossing";
}

/** A round that clears, with the clearing fields of `T` alongside the discriminant. */
export type Cleared<T> = { readonly outcome: "cleared" } & T;

/** Result of a round. */
export type Outcome<T> = NoCrossing | Cleared<T>;

/** Reason a book cannot be cleared, one per `ClearingError` variant of the engine. */
export type ClearingErrorCode =
  | "math"
  | "duplicate_order_id"
  | "quantity_overflow"
  | "invalid_pricing"
  | "min_fill_above_claim"
  | "budget_exceeded";

/** A book the engine cannot clear. */
export class ClearingError extends Error {
  /** The failure code. */
  readonly code: ClearingErrorCode;
  /** The duplicated id, for `duplicate_order_id`. */
  readonly orderId: bigint | undefined;

  /**
   * @param code - The failure code.
   * @param detail - The arithmetic failure (`math`) or the duplicated id (`duplicate_order_id`).
   */
  constructor(code: ClearingErrorCode, detail?: MathError | bigint) {
    super(clearingErrorMessage(code, detail));
    this.name = "ClearingError";
    this.code = code;
    this.orderId = typeof detail === "bigint" ? detail : undefined;
    if (detail instanceof MathError) {
      this.cause = detail;
    }
  }
}

function clearingErrorMessage(code: ClearingErrorCode, detail: MathError | bigint | undefined): string {
  switch (code) {
    case "math":
      return `clearing arithmetic: ${detail instanceof MathError ? detail.message : "failure"}`;
    case "duplicate_order_id":
      return `duplicate order id ${typeof detail === "bigint" ? detail.toString() : "unknown"}`;
    case "quantity_overflow":
      return "order quantities overflow";
    case "invalid_pricing":
      return "invalid pricing parameters";
    case "min_fill_above_claim":
      return "minimum fill exceeds the claim";
    case "budget_exceeded":
      return "charge exceeds the budget";
  }
}

/** Conversion between unit quantities, prices per whole locked token and cash. */
export interface Pricing {
  /** Locked fraction of one unit at the settlement time, `ONE - f(ts)`. */
  readonly lockedFractionE18: bigint;
  /** Decimals of the class token (`u8`). */
  readonly tokenDecimals: number;
}

/**
 * Pricing of an Advance: prices are per claimed token, and a claimed token is one whole future
 * token, so no locked fraction applies.
 */
export function perClaimedToken(tokenDecimals: number): Pricing {
  return { lockedFractionE18: ONE, tokenDecimals };
}

/**
 * Cash charged to a buyer for `qty` units at `price`, rounded up.
 *
 * @throws {ClearingError} `invalid_pricing` when `10^tokenDecimals` does not fit, `math` when the
 * cash does not fit in 128 bits.
 */
export function charge(pricing: Pricing, qty: bigint, price: bigint): bigint {
  return cash(pricing, qty, price, "up");
}

/**
 * Cash paid to a seller for `qty` units at `price`, rounded down.
 *
 * @throws {ClearingError} See {@link charge}.
 */
export function payout(pricing: Pricing, qty: bigint, price: bigint): bigint {
  return cash(pricing, qty, price, "down");
}

/**
 * Largest quantity whose cost at `price` fits in `budget`:
 * `floor(budget * ONE * 10^decimals / (lockedFraction * price))`, saturating at
 * {@link U128_MAX} (and unbounded when the cost per unit is zero).
 *
 * @throws {ClearingError} `invalid_pricing` when `10^tokenDecimals` does not fit.
 */
export function affordable(pricing: Pricing, budget: bigint, price: bigint): bigint {
  assertU128(pricing.lockedFractionE18, "lockedFractionE18");
  assertU128(budget, "budget");
  assertU128(price, "price");
  if (pricing.lockedFractionE18 === 0n || price === 0n) {
    return U128_MAX;
  }
  const scale = scaleOf(pricing);
  try {
    return mulDivWide([budget, ONE, scale], [pricing.lockedFractionE18, price], "down");
  } catch (error) {
    if (error instanceof MathError) {
      if (error.code === "overflow") {
        return U128_MAX;
      }
      throw new ClearingError("math", error);
    }
    throw error;
  }
}

/** A cleared Tender. */
export interface TenderClearing {
  /** Clearing price `P*` per whole locked token, paid to every filled seller. */
  readonly price: bigint;
  /** Units bought. */
  readonly volume: bigint;
  /** One fill per ask, in input order; `cash` is the seller's proceeds (rounded down). */
  readonly asks: readonly Fill[];
  /**
   * Cash charged to the issuer for the whole volume (rounded up). This is the notional the fee is
   * computed on.
   */
  readonly charged: bigint;
  /** Unspent budget refunded to the issuer, `budget - charged` (fees excluded). */
  readonly refund: bigint;
}

/** Inputs of a Tender: one public buyer (the issuer) with a public budget and max price, sealed asks. */
export interface TenderBook {
  /** The opened asks. */
  readonly asks: readonly Order[];
  /** The issuer's budget in cash base units, fees excluded. */
  readonly budget: bigint;
  /** The issuer's maximum price per whole locked token. */
  readonly maxPrice: bigint;
  /** Unit pricing at the settlement time. */
  readonly pricing: Pricing;
}

/**
 * Clears a Tender.
 *
 * Candidate prices are the submitted ask prices `<= maxPrice`. With `S(P)` the quantity asked at
 * or below `P` and `Q(P) = min(S(P), affordable(budget, P))`, the clearing price `P*` is the
 * candidate maximizing `Q`, ties to the lowest price. Asks fill in ascending price order (then
 * ascending id); the marginal price level is rationed pro rata; every filled seller receives
 * `P*`. If `Q(P*) == 0` the Tender does not cross. Asks above `maxPrice` and asks of zero
 * quantity are never filled.
 *
 * @throws {ClearingError} When the book cannot be cleared.
 * @throws {RangeError} When an input is outside its integer domain.
 */
export function tender(book: TenderBook): Outcome<TenderClearing> {
  const { asks, budget, maxPrice, pricing } = book;
  assertU128(budget, "budget");
  assertU128(maxPrice, "maxPrice");
  validatePricing(pricing);
  assertOrders(asks);
  ensureUniqueIds(asks);

  const eligible = priority(asks, ascending).filter((i) => at(asks, i).price <= maxPrice);

  let best: { volume: bigint; price: bigint; filledPrefix: number } | undefined;
  let supply = 0n;
  let start = 0;
  while (start < eligible.length) {
    const price = at(asks, at(eligible, start)).price;
    const end = levelEnd(asks, eligible, start, price);
    supply += sumQty(asks, eligible.slice(start, end));
    if (supply > U128_MAX) {
      throw new ClearingError("quantity_overflow");
    }
    const bound = affordable(pricing, budget, price);
    const volume = supply < bound ? supply : bound;
    if (best === undefined || volume > best.volume) {
      best = { volume, price, filledPrefix: end };
    }
    start = end;
  }

  if (best === undefined || best.volume === 0n) {
    return { outcome: "no_crossing" };
  }
  const { volume, price, filledPrefix } = best;

  const quantities = allocate(asks, eligible.slice(0, filledPrefix), volume);

  const charged = charge(pricing, volume, price);
  if (charged > budget) {
    throw new ClearingError("budget_exceeded");
  }
  const refund = budget - charged;
  const askFills = fills(asks, quantities, (qty) => payout(pricing, qty, price));

  return { outcome: "cleared", price, volume, asks: askFills, charged, refund };
}

/** A cleared Exit or Advance. */
export interface UniformClearing {
  /** Clearing price `P*` per whole token. */
  readonly price: bigint;
  /** Quantity traded. */
  readonly volume: bigint;
  /**
   * One fill per bid, in input order; `cash` is charged to the buyer (rounded up), fees excluded.
   * Unfilled escrow is refunded by the caller.
   */
  readonly bids: readonly Fill[];
  /** One fill per ask, in input order; `cash` is paid to the seller (rounded down). */
  readonly asks: readonly Fill[];
  /** Sum of the buyers' charges: the settled notional fees are computed on. */
  readonly notional: bigint;
}

/** Inputs of an Exit: sealed bids against sealed asks at one uniform price. */
export interface ExitBook {
  /** The opened bids. */
  readonly bids: readonly Order[];
  /** The opened asks. */
  readonly asks: readonly Order[];
  /** Unit pricing at the settlement time. */
  readonly pricing: Pricing;
}

/**
 * The holder's side of an Advance: a sealed reserve for a claim on the first `claim` tokens that
 * unlock from the encumbered units.
 */
export interface AdvanceAsk {
  /** Order id of the holder's ask (`u64`). */
  readonly id: bigint;
  /** Claim size `K` in token base units. */
  readonly claim: bigint;
  /** Sealed reserve price per whole claimed token. */
  readonly reserve: bigint;
  /** Public minimum fill in token base units; a smaller volume does not cross. */
  readonly minFill: bigint;
}

/** Inputs of an Advance: the holder's reserve against sealed bids from funders. */
export interface AdvanceBook {
  /** The holder's opened reserve. */
  readonly ask: AdvanceAsk;
  /** The opened bids. */
  readonly bids: readonly Order[];
  /** Decimals of the class token (`u8`). */
  readonly tokenDecimals: number;
}

/**
 * Clears an Exit round.
 *
 * With `D(P)` the bid quantity with limit `>= P`, `S(P)` the ask quantity with minimum `<= P`
 * and `V(P) = min(D(P), S(P))`, the clearing price maximizes `V`; ties go to the smallest
 * `|D - S|`, then to the midpoint of the tied price interval rounded down to a tick. That
 * interval is always contiguous because `D` is non-increasing and `S` non-decreasing.
 *
 * Fill rule at `P*`: bids with limit `>= P*` and asks with minimum `<= P*` are eligible. Each
 * side is ordered by price priority (bids by descending limit, asks by ascending minimum, then
 * ascending id) and filled with `V(P*)` units: whole price levels fill while the cumulative
 * quantity stays within `V(P*)`, the first level that does not fit is rationed pro rata by
 * largest remainder (ties to the lower id), later levels get nothing. The short side's eligible
 * quantity equals `V(P*)`, so it fills fully; only the long side is rationed.
 *
 * @throws {ClearingError} When the book cannot be cleared.
 * @throws {RangeError} When an input is outside its integer domain.
 */
export function exit(book: ExitBook): Outcome<UniformClearing> {
  return clear(book.bids, book.asks, book.pricing, 1n);
}

/**
 * Clears an Advance round.
 *
 * The holder's reserve is a single ask of `claim` tokens; funders bid per claimed token. The
 * price and fills follow {@link exit} with that one ask; the holder may be filled partially, but
 * a volume below `minFill` does not cross. Cash is `qty * P / 10^decimals`: a claimed token is a
 * whole future token rather than a unit of the class, so the locked fraction does not apply.
 *
 * @throws {ClearingError} `min_fill_above_claim`, or any failure of {@link exit}.
 * @throws {RangeError} When an input is outside its integer domain.
 */
export function advance(book: AdvanceBook): Outcome<UniformClearing> {
  const { ask, bids, tokenDecimals } = book;
  assertU64(ask.id, "ask.id");
  assertU128(ask.claim, "ask.claim");
  assertU128(ask.reserve, "ask.reserve");
  assertU128(ask.minFill, "ask.minFill");
  if (ask.minFill > ask.claim) {
    throw new ClearingError("min_fill_above_claim");
  }
  const asks: Order[] = [{ id: ask.id, qty: ask.claim, price: ask.reserve }];
  return clear(bids, asks, perClaimedToken(tokenDecimals), ask.minFill > 1n ? ask.minFill : 1n);
}

function clear(
  bids: readonly Order[],
  asks: readonly Order[],
  pricing: Pricing,
  minVolume: bigint,
): Outcome<UniformClearing> {
  validatePricing(pricing);
  assertOrders(bids);
  assertOrders(asks);
  ensureUniqueIds(bids);
  ensureUniqueIds(asks);

  const bidPriority = priority(bids, descending);
  const askPriority = priority(asks, ascending);
  const crossed = crossing(bids, bidPriority, asks, askPriority);
  if (crossed === undefined || crossed.volume < minVolume) {
    return { outcome: "no_crossing" };
  }
  const { price, volume } = crossed;

  const eligibleBids = countWhile(bidPriority, (i) => at(bids, i).price >= price);
  const eligibleAsks = countWhile(askPriority, (i) => at(asks, i).price <= price);
  const bidQuantities = allocate(bids, bidPriority.slice(0, eligibleBids), volume);
  const askQuantities = allocate(asks, askPriority.slice(0, eligibleAsks), volume);

  const bidFills = fills(bids, bidQuantities, (qty) => charge(pricing, qty, price));
  const askFills = fills(asks, askQuantities, (qty) => payout(pricing, qty, price));
  let notional = 0n;
  for (const fill of bidFills) {
    notional += fill.cash;
    if (notional > U128_MAX) {
      throw new ClearingError("quantity_overflow");
    }
  }

  return { outcome: "cleared", price, volume, bids: bidFills, asks: askFills, notional };
}

/**
 * Finds `(P*, V(P*))`, or `undefined` when no price trades a positive volume.
 *
 * `D` and `S` only change at ask minimums `m` (where `S` rises) and at `limit + 1` for every
 * bid limit (where `D` falls). Those breakpoints, plus `0`, split the tick axis into segments of
 * constant `(D, S)`; the sweep evaluates each segment once and widens the tied interval over
 * consecutive optimal segments.
 */
function crossing(
  bids: readonly Order[],
  bidPriority: readonly number[],
  asks: readonly Order[],
  askPriority: readonly number[],
): { price: bigint; volume: bigint } | undefined {
  const breakpoints: bigint[] = [0n];
  for (const i of askPriority) {
    breakpoints.push(at(asks, i).price);
  }
  for (const i of bidPriority) {
    const limit = at(bids, i).price;
    if (limit < U128_MAX) {
      breakpoints.push(limit + 1n);
    }
  }
  breakpoints.sort(compareBigint);
  const ticks = breakpoints.filter((tick, k) => k === 0 || tick !== breakpoints[k - 1]);

  let demand = sumQty(bids, bidPriority);
  // Checking the full supply once keeps every partial sum of the sweep in range.
  sumQty(asks, askPriority);
  let supply = 0n;
  // Bids by ascending limit, so the sweep can drop them as the price passes their limit.
  const bidsAscending = [...bidPriority].reverse();
  let nextBid = 0;
  let nextAsk = 0;
  let best: { volume: bigint; gap: bigint; low: bigint; high: bigint } | undefined;

  for (const [k, low] of ticks.entries()) {
    while (nextAsk < askPriority.length && at(asks, at(askPriority, nextAsk)).price <= low) {
      supply += at(asks, at(askPriority, nextAsk)).qty;
      nextAsk += 1;
    }
    while (nextBid < bidsAscending.length && at(bids, at(bidsAscending, nextBid)).price < low) {
      demand -= at(bids, at(bidsAscending, nextBid)).qty;
      nextBid += 1;
    }
    const next = ticks[k + 1];
    const high = next === undefined ? U128_MAX : next - 1n;
    const volume = demand < supply ? demand : supply;
    const gap = demand > supply ? demand - supply : supply - demand;
    if (best === undefined || volume > best.volume || (volume === best.volume && gap < best.gap)) {
      best = { volume, gap, low, high };
    } else if (volume === best.volume && gap === best.gap) {
      best = { ...best, high };
    }
  }

  if (best === undefined || best.volume === 0n) {
    return undefined;
  }
  return { price: best.low + (best.high - best.low) / 2n, volume: best.volume };
}

function validatePricing(pricing: Pricing): void {
  assertU128(pricing.lockedFractionE18, "lockedFractionE18");
  if (pricing.lockedFractionE18 > ONE) {
    throw new ClearingError("invalid_pricing");
  }
  scaleOf(pricing);
}

function scaleOf(pricing: Pricing): bigint {
  try {
    return pow10(pricing.tokenDecimals);
  } catch (error) {
    if (error instanceof MathError) {
      throw new ClearingError("invalid_pricing");
    }
    throw error;
  }
}

function cash(pricing: Pricing, qty: bigint, price: bigint, rounding: "up" | "down"): bigint {
  assertU128(pricing.lockedFractionE18, "lockedFractionE18");
  assertU128(qty, "qty");
  assertU128(price, "price");
  const scale = scaleOf(pricing);
  try {
    return mulDivWide([qty, pricing.lockedFractionE18, price], [ONE, scale], rounding);
  } catch (error) {
    if (error instanceof MathError) {
      throw new ClearingError("math", error);
    }
    throw error;
  }
}

function assertOrders(orders: readonly Order[]): void {
  for (const order of orders) {
    assertU64(order.id, "order.id");
    assertU128(order.qty, "order.qty");
    assertU128(order.price, "order.price");
  }
}

function ensureUniqueIds(orders: readonly Order[]): void {
  const ids = orders.map((order) => order.id).sort(compareBigint);
  for (let k = 1; k < ids.length; k += 1) {
    const previous = at(ids, k - 1);
    if (previous === at(ids, k)) {
      throw new ClearingError("duplicate_order_id", previous);
    }
  }
}

/**
 * Indices of the orders with a positive quantity, sorted by price priority then ascending id.
 * `better` orders two prices: a negative result means the first has priority.
 */
function priority(orders: readonly Order[], better: (a: bigint, b: bigint) => number): number[] {
  const indices: number[] = [];
  for (const [i, order] of orders.entries()) {
    if (order.qty > 0n) {
      indices.push(i);
    }
  }
  return indices.sort((a, b) => {
    const byPrice = better(at(orders, a).price, at(orders, b).price);
    return byPrice !== 0 ? byPrice : compareBigint(at(orders, a).id, at(orders, b).id);
  });
}

function sumQty(orders: readonly Order[], indices: readonly number[]): bigint {
  let sum = 0n;
  for (const i of indices) {
    sum += at(orders, i).qty;
    if (sum > U128_MAX) {
      throw new ClearingError("quantity_overflow");
    }
  }
  return sum;
}

/**
 * Fills `target` units from `eligible` (sorted by price priority, then id): whole price levels
 * are filled while the cumulative quantity stays within `target`; the first level that does not
 * fit (the marginal level) is rationed with `ration`; later levels get nothing. When the eligible
 * quantity equals `target` (the short side), every eligible order fills fully.
 */
function allocate(orders: readonly Order[], eligible: readonly number[], target: bigint): bigint[] {
  const fills: bigint[] = orders.map(() => 0n);
  let remaining = target;
  let start = 0;
  while (start < eligible.length && remaining > 0n) {
    const price = at(orders, at(eligible, start)).price;
    const end = levelEnd(orders, eligible, start, price);
    const level = eligible.slice(start, end);
    const levelQty = sumQty(orders, level);
    if (levelQty <= remaining) {
      for (const i of level) {
        fills[i] = at(orders, i).qty;
      }
      remaining -= levelQty;
    } else {
      ration(orders, level, remaining, levelQty, fills);
      remaining = 0n;
    }
    start = end;
  }
  return fills;
}

/**
 * Largest remainder (Hamilton) rationing of `amount < levelQty` units over one price level:
 * each order gets `floor(amount * qty / levelQty)`, and the units left over go one each to the
 * orders with the largest remainders `(amount * qty) mod levelQty`, ties to the lower id. The
 * fills sum to `amount` exactly and never exceed an order's quantity.
 */
function ration(
  orders: readonly Order[],
  level: readonly number[],
  amount: bigint,
  levelQty: bigint,
  fills: bigint[],
): void {
  const remainders: { remainder: bigint; id: bigint; index: number }[] = [];
  let assigned = 0n;
  for (const i of level) {
    const { quotient, remainder } = mulDivRemChecked(amount, at(orders, i).qty, levelQty);
    fills[i] = quotient;
    assigned += quotient;
    remainders.push({ remainder, id: at(orders, i).id, index: i });
  }
  remainders.sort((a, b) => {
    const byRemainder = compareBigint(b.remainder, a.remainder);
    return byRemainder !== 0 ? byRemainder : compareBigint(a.id, b.id);
  });
  // Fewer units are left over than there are orders on the level, so the count is a small integer.
  const leftover = Number(amount - assigned);
  for (const { index } of remainders.slice(0, leftover)) {
    fills[index] = at(fills, index) + 1n;
  }
}

function mulDivRemChecked(a: bigint, b: bigint, c: bigint): { quotient: bigint; remainder: bigint } {
  try {
    return mulDivRem(a, b, c);
  } catch (error) {
    if (error instanceof MathError) {
      throw new ClearingError("math", error);
    }
    throw error;
  }
}

function fills(
  orders: readonly Order[],
  quantities: readonly bigint[],
  cashOf: (qty: bigint) => bigint,
): Fill[] {
  return orders.map((order, i) => {
    const qty = at(quantities, i);
    return { id: order.id, qty, cash: cashOf(qty) };
  });
}

/** Index one past the last entry of `eligible` (from `start`) whose price equals `price`. */
function levelEnd(orders: readonly Order[], eligible: readonly number[], start: number, price: bigint): number {
  let end = start;
  while (end < eligible.length && at(orders, at(eligible, end)).price === price) {
    end += 1;
  }
  return end;
}

function countWhile(indices: readonly number[], keep: (index: number) => boolean): number {
  let count = 0;
  while (count < indices.length && keep(at(indices, count))) {
    count += 1;
  }
  return count;
}

function ascending(a: bigint, b: bigint): number {
  return compareBigint(a, b);
}

function descending(a: bigint, b: bigint): number {
  return compareBigint(b, a);
}

function compareBigint(a: bigint, b: bigint): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`index ${String(index)} out of bounds`);
  }
  return item;
}
