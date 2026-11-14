/**
 * Rounds: creation, sealed orders, and the permissionless lifecycle (close, open, clear, settle).
 * The check that the engine's clearing equals the `@rose/sdk` reference is in `clearing.ts`.
 */

import { charge, fee, type FunctionCall, type Pricing, type Round, type RoundKind, type Side, type Venue } from "@rose/sdk";
import type { Context } from "./context.ts";
import { log, sleep } from "./env.ts";
import { CAST, type Who } from "./identity.ts";
import type { StepScope } from "./journal.ts";
import { nearRef, withRetry, type NearActor } from "./near.ts";
import { corrupt, seal } from "./sealed.ts";
import { bidStorageTopUp } from "./storage.ts";

export interface RoundRecord {
  roundId: string;
  kind: RoundKind;
  classId: string;
  creator: string;
  closesAt: string;
  revealWindow: string;
}

export interface OrderRecord {
  roundId: string;
  bidId: number;
  who: Who;
  bidder: string;
  side: Side;
  /** Units locked (asks) or cash escrowed (bids), base units. */
  collateral: string;
  ciphertextSha256: string;
  malformed: boolean;
}

/** What only the bidder knows until the key is released (stored in the private journal). */
export interface OrderSecret {
  quantity: string;
  price: string;
  salt: string;
  ciphertextHex: string;
  /** For the malformed order: the well-formed ciphertext it was derived from. */
  originalCiphertextHex?: string;
}

export async function getRound(ctx: Context, roundId: string): Promise<Round> {
  const round = await withRetry("get_round", () => ctx.views.getRound(roundId));
  if (round === null) throw new Error(`round ${roundId} not found`);
  return round;
}

export async function classDecimals(ctx: Context, classId: string): Promise<number> {
  const cls = await withRetry("get_class", () => ctx.views.getClass(classId));
  if (cls === null) throw new Error(`class ${classId} not found`);
  return cls.decimals;
}

/** Escrow of a bid: its charge plus the fee, rounded up to a whole tUSDC (the escrow is public). */
export function escrowFor(pricing: Pricing, quantity: bigint, price: bigint): bigint {
  const cost = charge(pricing, quantity, price);
  const total = cost + fee(cost);
  return ((total + 999_999n) / 1_000_000n) * 1_000_000n;
}

/** Time a reused round must still accept orders for: a resumed run places its orders right after. */
export const REUSE_MARGIN_NANOS = 60_000_000_000n;

/**
 * The creator's open round a resumed run reuses (its creation landed but was not journaled): only
 * one whose window still accepts orders, since an `Open` round past `closes_at` refuses them
 * ("Round is closed") until someone calls `close`.
 */
export function reusableRound<T extends { closesAt: bigint }>(open: readonly T[], nowNanos: bigint): T | undefined {
  return open.find((round) => round.closesAt > nowNanos + REUSE_MARGIN_NANOS);
}

/**
 * Creates the round, or finds the open round the same creator already opened on the class (a
 * run that stopped after the transaction and before recording it).
 */
export async function createRound(ctx: Context, scope: StepScope, label: string, creator: NearActor, kind: RoundKind, classId: string, call: FunctionCall): Promise<RoundRecord> {
  const existing = await withRetry("get_rounds", () => ctx.views.getRounds({ kind, class_id: classId, status: "Open", creator: creator.accountId }));
  let round = reusableRound(existing.rounds, BigInt(Date.now()) * 1_000_000n);
  if (round === undefined) {
    const result = await creator.call(call);
    scope.tx(nearRef(label, result));
    round = await getRound(ctx, String(result.value));
  }
  log(`  ${kind} round ${round.roundId} closes ${new Date(Number(round.closesAt / 1_000_000n)).toISOString()}`);
  return { roundId: round.roundId.toString(), kind, classId, creator: creator.accountId, closesAt: round.closesAt.toString(), revealWindow: round.revealWindow.toString() };
}

async function sha256Hex(hex: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(hex, "hex"));
  return Buffer.from(digest).toString("hex");
}

/**
 * Seals and places one order. Asks lock `collateral` units, bids escrow `collateral` cash. The
 * secret is stored before the transaction, so a resumed run never seals the same order twice.
 */
export async function placeOrder(
  ctx: Context,
  scope: StepScope,
  round: RoundRecord,
  who: Who,
  actor: NearActor,
  side: Side,
  order: { quantity: bigint; price: bigint; collateral: bigint; malformed?: boolean },
): Promise<OrderRecord> {
  const secretKey = `order:${round.roundId}:${actor.accountId}:${side}`;
  const secret = await ctx.secrets.step<OrderSecret>(secretKey, () => {
    const sealed = seal({ mpk: ctx.config.ckd_public_key, engine: ctx.engine, roundId: BigInt(round.roundId), bidder: actor.accountId, side }, order.quantity, order.price);
    return Promise.resolve({
      quantity: order.quantity.toString(),
      price: order.price.toString(),
      salt: sealed.salt,
      ciphertextHex: order.malformed === true ? corrupt(sealed.ciphertextHex) : sealed.ciphertextHex,
      ...(order.malformed === true ? { originalCiphertextHex: sealed.ciphertextHex } : {}),
    });
  });
  let bidId = await withRetry("get_order_id", () => ctx.views.getOrderId(round.roundId, actor.accountId, side));
  if (bidId === null && side === "Buy" && round.kind === "Exit") {
    const [storage, minimum, holding] = await Promise.all([
      withRetry("storage_balance_of", () => ctx.views.storageBalanceOf(actor.accountId)),
      withRetry("storage_balance_bounds", () => ctx.views.storageMinimum()),
      withRetry("get_holding", () => ctx.views.getHolding(actor.accountId, round.classId)),
    ]);
    const topUp = bidStorageTopUp(storage, minimum, holding);
    if (topUp > 0n) scope.tx(nearRef(`${CAST[who].name}: engine storage for the bought units' holding row`, await actor.call(ctx.calls.storageDeposit(topUp))));
  }
  if (bidId === null) {
    const call = side === "Sell" ? ctx.calls.placeAsk(BigInt(round.roundId), secret.ciphertextHex, order.collateral) : ctx.calls.placeBid(BigInt(round.roundId), secret.ciphertextHex, order.collateral);
    const result = await actor.call(call);
    scope.tx(nearRef(`${CAST[who].name}: place_${side === "Sell" ? "ask" : "bid"}${order.malformed === true ? " (malformed ciphertext)" : ""}`, result));
    bidId = Number(result.value);
  }
  return {
    roundId: round.roundId,
    bidId,
    who,
    bidder: actor.accountId,
    side,
    collateral: order.collateral.toString(),
    ciphertextSha256: await sha256Hex(secret.ciphertextHex),
    malformed: order.malformed === true,
  };
}

export async function waitUntil(nanos: bigint, what: string): Promise<void> {
  const ms = Number(nanos / 1_000_000n) - Date.now();
  if (ms > 0) {
    log(`  waiting ${Math.ceil(ms / 1000)} s for ${what}`);
    await sleep(ms + 3_000);
  }
}

export function venueLabel(venue: Venue): string {
  return venue === "Near" ? "NEAR tUSDC" : `Base ${venue.Base.token}`;
}

export function usdcText(amount: bigint): string {
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  return `${sign}${(abs / 1_000_000n).toString()}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}
