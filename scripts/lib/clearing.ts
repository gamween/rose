/**
 * The check that a round's on-chain clearing equals the `@rose/sdk` clearing reference run on the
 * round's opened orders. Its only runtime imports are the SDK's `clearing` and `math` entry points,
 * so `verify.ts` can load it from the SDK's TypeScript sources without a build.
 */

import { advance, exit, fee, perClaimedToken, tender, type Order, type Pricing } from "@rose/sdk/clearing";
import { ONE } from "@rose/sdk/math";
import type { Round, RoundResult } from "@rose/sdk";

export function pricingOf(round: Round, decimals: number): Pricing {
  return round.kind === "Advance" ? perClaimedToken(decimals) : { lockedFractionE18: ONE - round.fTs, tokenDecimals: decimals };
}

/** The opened, valid orders of a cleared or cancelled round as the engine fed them to clearing. */
function validOrders(round: Round, result: RoundResult): { buys: Order[]; sells: Order[] } {
  const buys: Order[] = [];
  const sells: Order[] = [];
  for (const fill of result.fills) {
    if (fill.opened === null || fill.void !== null || fill.opened.price > round.maxPrice) continue;
    const order = { id: BigInt(fill.bidId), qty: fill.opened.quantity, price: fill.opened.price };
    if (fill.side === "Buy") buys.push(order);
    else sells.push(order);
  }
  return { buys, sells };
}

export interface ClearingCheck {
  matches: boolean;
  /** The opened, valid orders fed to the reference. */
  orders: number;
  engine: { price: string; volume: string; notional: string; fee: string; fills: { bidId: number; qty: string; cash: string }[] };
  reference: { price: string; volume: string; notional: string; fee: string; fills: { bidId: number; qty: string; cash: string }[] } | "no_crossing";
}

/** Recomputes the round with the SDK clearing reference and compares price, volume, notional, fee and every fill. */
export function checkClearing(round: Round, decimals: number): ClearingCheck {
  const result = round.result;
  if (result === null) throw new Error(`round ${round.roundId} has no result`);
  const { buys, sells } = validOrders(round, result);
  const pricing = pricingOf(round, decimals);
  const engineFills = result.fills.map((f) => ({ bidId: f.bidId, qty: f.fillQuantity.toString(), cash: f.cash.toString() }));
  const engine = { price: result.price.toString(), volume: result.volume.toString(), notional: result.notional.toString(), fee: result.fee.toString(), fills: engineFills };
  const zero = (id: number) => ({ bidId: id, qty: "0", cash: "0" });
  let reference: ClearingCheck["reference"];
  if (round.kind === "Tender") {
    if (round.budget === null) throw new Error("tender without budget");
    const cleared = tender({ asks: sells, budget: round.budget, maxPrice: round.maxPrice, pricing });
    reference =
      cleared.outcome === "no_crossing"
        ? "no_crossing"
        : {
            price: cleared.price.toString(),
            volume: cleared.volume.toString(),
            notional: cleared.charged.toString(),
            fee: fee(cleared.charged).toString(),
            fills: result.fills.map((f) => {
              const fill = cleared.asks.find((a) => a.id === BigInt(f.bidId));
              return fill === undefined ? zero(f.bidId) : { bidId: f.bidId, qty: fill.qty.toString(), cash: fill.cash.toString() };
            }),
          };
  } else {
    let cleared;
    if (round.kind === "Exit") {
      cleared = exit({ bids: buys, asks: sells, pricing });
    } else {
      const ask = sells[0];
      if (ask === undefined || round.advanceClaim === null || round.advanceMinFill === null) throw new Error("advance without an opened reserve");
      cleared = advance({ ask: { id: ask.id, claim: round.advanceClaim, reserve: ask.price, minFill: round.advanceMinFill }, bids: buys, tokenDecimals: decimals });
    }
    if (cleared.outcome === "no_crossing") {
      reference = "no_crossing";
    } else {
      // Order ids are bid ids, unique across both sides of a round.
      const all = [...cleared.bids, ...cleared.asks];
      const fills = result.fills.map((f) => {
        const fill = all.find((a) => a.id === BigInt(f.bidId));
        return fill === undefined ? zero(f.bidId) : { bidId: f.bidId, qty: fill.qty.toString(), cash: fill.cash.toString() };
      });
      const totalFee = cleared.bids.reduce((sum, b) => sum + fee(b.cash), 0n);
      reference = { price: cleared.price.toString(), volume: cleared.volume.toString(), notional: cleared.notional.toString(), fee: totalFee.toString(), fills };
    }
  }
  const matches = reference !== "no_crossing" && round.status === "Settled" && JSON.stringify(reference) === JSON.stringify(engine);
  return { matches: reference === "no_crossing" ? round.status === "Cancelled" : matches, orders: buys.length + sells.length, engine, reference };
}
