/**
 * Supply and demand curves of a round from its opened orders (spec 5.4), as step functions on
 * the price axis the clearing chart draws, plus the book builder shared with the Verify panel.
 * Prices are USDC base units per whole locked token; quantities are token base units.
 */

import { affordable, type Bid, type Order, type Pricing, type Round } from "@rose/sdk";
import { roundPricing } from "./model";

export interface Book {
  bids: Order[];
  asks: Order[];
  /** Opened orders left out of the book: void, or priced above the round's max price. */
  excluded: { bidId: number; reason: string }[];
  /** Sealed orders nobody opened yet. */
  unopened: number;
}

/** The orders the engine clears: opened, not void, priced at or under `max_price` (`settlement.rs::valid_orders`). */
export function buildBook(round: Pick<Round, "maxPrice">, bids: readonly Bid[]): Book {
  const book: Book = { bids: [], asks: [], excluded: [], unopened: 0 };
  for (const bid of bids) {
    if (bid.opened === null) {
      if (bid.status === "Sealed") book.unopened += 1;
      else book.excluded.push({ bidId: bid.bidId, reason: bid.void ?? "Unopened" });
      continue;
    }
    if (bid.void !== null) {
      book.excluded.push({ bidId: bid.bidId, reason: bid.void });
      continue;
    }
    if (bid.opened.price > round.maxPrice) {
      book.excluded.push({ bidId: bid.bidId, reason: "AboveMaxPrice" });
      continue;
    }
    const order: Order = { id: BigInt(bid.bidId), qty: bid.opened.quantity, price: bid.opened.price };
    if (bid.side === "Buy") book.bids.push(order);
    else book.asks.push(order);
  }
  return book;
}

export interface CurveStep {
  /** Interval `[from, to)` on the price axis where both quantities are constant. */
  from: bigint;
  to: bigint;
  demand: bigint;
  supply: bigint;
}

export interface Curves {
  steps: CurveStep[];
  /** Highest quantity on either curve (the y extent). */
  maxQty: bigint;
  /** Right edge of the price axis. */
  maxPrice: bigint;
  /** Distinct order prices, ascending (the x ticks that matter). */
  prices: bigint[];
}

function demandAt(bids: readonly Order[], price: bigint): bigint {
  let total = 0n;
  for (const bid of bids) if (bid.price >= price) total += bid.qty;
  return total;
}

function supplyAt(asks: readonly Order[], price: bigint): bigint {
  let total = 0n;
  for (const ask of asks) if (ask.price <= price) total += ask.qty;
  return total;
}

function distinctSorted(values: bigint[]): bigint[] {
  return [...new Set(values.map((v) => v.toString()))].map((v) => BigInt(v)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Exit and Advance curves: `D(P)` is the bid quantity with limit `>= P` (non-increasing, drops
 * one tick above each limit), `S(P)` the ask quantity with minimum `<= P` (non-decreasing, rises
 * at each minimum). The axis is cut at every breakpoint so each step carries exact values.
 */
export function uniformCurves(bids: readonly Order[], asks: readonly Order[], axisMax: bigint): Curves {
  const prices = distinctSorted([...bids, ...asks].map((o) => o.price));
  const breakpoints = distinctSorted([0n, ...asks.map((a) => a.price), ...bids.map((b) => b.price + 1n)]).filter((p) => p < axisMax);
  const steps: CurveStep[] = [];
  let maxQty = 0n;
  for (let i = 0; i < breakpoints.length; i += 1) {
    const from = breakpoints[i] as bigint;
    const to = i + 1 < breakpoints.length ? (breakpoints[i + 1] as bigint) : axisMax;
    const demand = demandAt(bids, from);
    const supply = supplyAt(asks, from);
    if (demand > maxQty) maxQty = demand;
    if (supply > maxQty) maxQty = supply;
    steps.push({ from, to, demand, supply });
  }
  return { steps, maxQty, maxPrice: axisMax, prices };
}

/**
 * Tender curves: supply as above, and the issuer's affordable quantity
 * `floor(budget / cost per unit at P)` (spec 5.4), sampled at the ask prices and on a grid so
 * the hyperbola reads as a curve.
 */
export function tenderCurves(asks: readonly Order[], budget: bigint, pricing: Pricing, axisMax: bigint, samples = 48): Curves {
  const prices = distinctSorted(asks.map((o) => o.price));
  const grid: bigint[] = [];
  for (let i = 1; i <= samples; i += 1) grid.push((axisMax * BigInt(i)) / BigInt(samples));
  const breakpoints = distinctSorted([0n, ...asks.map((a) => a.price), ...grid]).filter((p) => p < axisMax);
  const supplyMax = supplyAt(asks, axisMax);
  const steps: CurveStep[] = [];
  let maxQty = supplyMax;
  for (let i = 0; i < breakpoints.length; i += 1) {
    const from = breakpoints[i] as bigint;
    const to = i + 1 < breakpoints.length ? (breakpoints[i + 1] as bigint) : axisMax;
    const supply = supplyAt(asks, from);
    const unbounded = affordable(pricing, budget, from);
    const cap = supplyMax * 3n > 0n ? supplyMax * 3n : budget;
    const demand = unbounded > cap ? cap : unbounded;
    if (demand > maxQty) maxQty = demand;
    steps.push({ from, to, demand, supply });
  }
  return { steps, maxQty, maxPrice: axisMax, prices };
}

/** The curves of a round from its book, with the axis ending a little past the highest price in play. */
export function roundCurves(round: Pick<Round, "kind" | "fTs" | "maxPrice" | "budget">, decimals: number, book: Book): Curves {
  const top = [...book.bids, ...book.asks].reduce((max, o) => (o.price > max ? o.price : max), 0n);
  const axisMax = top > 0n ? top + top / 6n + 1n : round.maxPrice;
  if (round.kind === "Tender") return tenderCurves(book.asks, round.budget ?? 0n, roundPricing(round, decimals), axisMax);
  return uniformCurves(book.bids, book.asks, axisMax);
}

/**
 * Label of a price-axis tick: enough decimals for the tick step, so ticks 0.005 apart never print
 * the same text ("0.005 0.010 0.015", not "0.01 0.01 0.01"); whole numbers from a step of 1 up.
 */
export function priceTickLabel(value: number, step: number): string {
  if (step >= 1 || step <= 0) {
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
    return value.toFixed(0);
  }
  return value.toFixed(Math.max(2, Math.ceil(-Math.log10(step) - 1e-9)));
}
