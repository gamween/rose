/**
 * The "Verify" panel: recomputes the clearing price and every fill in the browser from the
 * opened orders with the `@rose/sdk` clearing reference (the exact port of
 * `contracts/engine/src/clearing`) and compares them with what the contract stored.
 */

import { advance, exit, tender, type Bid, type Fill, type Round } from "@rose/sdk";
import { buildBook, type Book } from "./curves";
import { roundPricing } from "./model";

export interface LocalFill {
  bidId: number;
  qty: bigint;
  cash: bigint;
}

export interface LocalClearing {
  outcome: "cleared" | "no_crossing";
  price: bigint | null;
  volume: bigint | null;
  fills: LocalFill[];
}

export type VerifyStatus = "pending" | "incomplete" | "match" | "mismatch" | "unsupported";

export interface Verification {
  status: VerifyStatus;
  book: Book;
  local: LocalClearing | null;
  /** What the engine stored, when the round is cleared. */
  onChain: { outcome: "cleared" | "no_crossing"; price: bigint | null; volume: bigint | null; fills: LocalFill[] } | null;
  /** Human-readable differences, empty on a match. */
  differences: string[];
  /** Why the local run could not happen. */
  reason: string | null;
}

function toFills(fills: readonly Fill[]): LocalFill[] {
  return fills.map((f) => ({ bidId: Number(f.id), qty: f.qty, cash: f.cash }));
}

/** Runs the reference on the book. Throws `ClearingError` on a book the engine would refuse too. */
export function recompute(round: Round, decimals: number, book: Book): LocalClearing {
  const pricing = roundPricing(round, decimals);
  if (round.kind === "Tender") {
    const result = tender({ asks: book.asks, budget: round.budget ?? 0n, maxPrice: round.maxPrice, pricing });
    if (result.outcome === "no_crossing") return { outcome: "no_crossing", price: null, volume: null, fills: [] };
    return { outcome: "cleared", price: result.price, volume: result.volume, fills: toFills(result.asks) };
  }
  if (round.kind === "Exit") {
    const result = exit({ bids: book.bids, asks: book.asks, pricing });
    if (result.outcome === "no_crossing") return { outcome: "no_crossing", price: null, volume: null, fills: [] };
    return { outcome: "cleared", price: result.price, volume: result.volume, fills: [...toFills(result.bids), ...toFills(result.asks)] };
  }
  const reserve = book.asks[0];
  if (!reserve || round.advanceClaim === null) return { outcome: "no_crossing", price: null, volume: null, fills: [] };
  const result = advance({
    ask: { id: reserve.id, claim: round.advanceClaim, reserve: reserve.price, minFill: round.advanceMinFill ?? 0n },
    bids: book.bids,
    tokenDecimals: decimals,
  });
  if (result.outcome === "no_crossing") return { outcome: "no_crossing", price: null, volume: null, fills: [] };
  return { outcome: "cleared", price: result.price, volume: result.volume, fills: [...toFills(result.bids), ...toFills(result.asks)] };
}

/** Compares the local recomputation with the on-chain result (or cancellation) of `round`. */
export function verifyRound(round: Round, decimals: number, bids: readonly Bid[]): Verification {
  const book = buildBook(round, bids);
  const cleared = round.status === "Settled" || (round.status === "Cancelled" && round.cancelReason === "NoCrossing");
  if (!cleared) {
    return { status: "pending", book, local: null, onChain: null, differences: [], reason: "The round is not cleared yet; the panel runs once `clear` has stored the result." };
  }
  if (book.unopened > 0) {
    return { status: "incomplete", book, local: null, onChain: null, differences: [], reason: `${String(book.unopened)} sealed orders were never opened; the engine voided them at clearing.` };
  }
  let local: LocalClearing;
  try {
    local = recompute(round, decimals, book);
  } catch (error) {
    return { status: "unsupported", book, local: null, onChain: null, differences: [], reason: error instanceof Error ? error.message : "The reference refused the book." };
  }
  // A no-crossing cancellation still stores a result (price 0, volume 0) so its orders can be
  // settled: the outcome on chain is "no crossing" whatever that record holds.
  const onChain =
    round.status === "Settled" && round.result !== null
      ? {
          outcome: "cleared" as const,
          price: round.result.price,
          volume: round.result.volume,
          fills: round.result.fills.filter((f) => f.fillQuantity > 0n).map((f) => ({ bidId: f.bidId, qty: f.fillQuantity, cash: f.cash })),
        }
      : { outcome: "no_crossing" as const, price: null, volume: null, fills: [] };
  const differences = compare(local, onChain);
  return { status: differences.length === 0 ? "match" : "mismatch", book, local, onChain, differences, reason: null };
}

function compare(local: LocalClearing, onChain: NonNullable<Verification["onChain"]>): string[] {
  const out: string[] = [];
  if (local.outcome !== onChain.outcome) {
    out.push(`Outcome: browser says ${local.outcome.replace("_", " ")}, chain says ${onChain.outcome.replace("_", " ")}.`);
    return out;
  }
  if (local.outcome === "no_crossing") return out;
  if (local.price !== onChain.price) out.push(`Clearing price: browser ${String(local.price)} vs chain ${String(onChain.price)}.`);
  if (local.volume !== onChain.volume) out.push(`Volume: browser ${String(local.volume)} vs chain ${String(onChain.volume)}.`);
  const chainById = new Map(onChain.fills.map((f) => [f.bidId, f]));
  const localById = new Map(local.fills.filter((f) => f.qty > 0n).map((f) => [f.bidId, f]));
  for (const [id, fill] of localById) {
    const theirs = chainById.get(id);
    if (!theirs) {
      out.push(`Order #${String(id)}: browser fills ${fill.qty.toString()}, chain fills nothing.`);
      continue;
    }
    if (theirs.qty !== fill.qty) out.push(`Order #${String(id)} quantity: browser ${fill.qty.toString()} vs chain ${theirs.qty.toString()}.`);
    if (theirs.cash !== fill.cash) out.push(`Order #${String(id)} cash: browser ${fill.cash.toString()} vs chain ${theirs.cash.toString()}.`);
  }
  for (const id of chainById.keys()) {
    if (!localById.has(id)) out.push(`Order #${String(id)}: chain fills it, browser does not.`);
  }
  return out;
}
