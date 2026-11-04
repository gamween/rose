/**
 * Pure transforms behind the Portfolio page: holdings joined with their class and valued at
 * `f(now)`, claim sources per chain, pending payouts, the account's slice of the event history.
 */

import { ONE, type Bid, type Cash, type ClassInfo, type Holding, type Lien, type LienShare, type PayoutView, type RetiredLot, type SolDrawArgs, type StoredEvent, type Venue } from "@rose/sdk";
import { RoseActionError } from "@/lib/errors";
import { nsToMs, sameVenue, tokensAtFraction } from "@/lib/amounts";
import { fractionAt } from "@/lib/unlock-schedule";

export type HoldingRow = {
  holding: Holding;
  info: ClassInfo;
  /** Free + locked in rounds + encumbered. */
  totalUnits: bigint;
  /** `f(now)` computed in the browser with the class schedule. */
  fractionNow: bigint;
  /** Tokens still locked across every unit held: `units * (1 - f(now))`. */
  lockedTokens: bigint;
  /** Tokens the units have unlocked so far (claimed or not): `units * f(now)`. */
  unlockedTokens: bigint;
};

/** Joins each holding with its class; holdings of unknown classes (never expected) are dropped. */
export function holdingRows(holdings: readonly Holding[], classes: ReadonlyMap<string, ClassInfo>, nowSec: bigint): HoldingRow[] {
  const rows: HoldingRow[] = [];
  for (const holding of holdings) {
    const info = classes.get(holding.classId);
    if (!info) continue;
    const totalUnits = holding.balance + holding.lockedInRounds + holding.encumbered;
    if (totalUnits === 0n && holding.claimable === 0n) continue;
    const fractionNow = fractionAt(info, nowSec);
    rows.push({ holding, info, totalUnits, fractionNow, lockedTokens: tokensAtFraction(totalUnits, ONE - fractionNow), unlockedTokens: tokensAtFraction(totalUnits, fractionNow) });
  }
  return rows.sort((a, b) => (a.totalUnits > b.totalUnits ? -1 : a.totalUnits < b.totalUnits ? 1 : 0));
}

export type ClaimSource =
  | { kind: "holding"; classId: string; amount: bigint; label: string }
  | { kind: "lienShare"; lienId: bigint; classId: string; amount: bigint; label: string }
  | { kind: "retired"; roundId: bigint; classId: string; amount: bigint; retireTo: string; label: string };

export type TokenClaim = { source: ClaimSource; info: ClassInfo };

/** Every token amount the account can claim now, with its engine `ClaimSource`, grouped by chain. */
export function tokenClaims(
  holdings: readonly Holding[],
  lienShares: readonly LienShare[],
  retiredLots: readonly RetiredLot[],
  classes: ReadonlyMap<string, ClassInfo>,
): { base: TokenClaim[]; solana: TokenClaim[] } {
  const claims: TokenClaim[] = [];
  for (const holding of holdings) {
    const info = classes.get(holding.classId);
    if (info && holding.claimable > 0n) claims.push({ info, source: { kind: "holding", classId: holding.classId, amount: holding.claimable, label: "Units" } });
  }
  for (const share of lienShares) {
    const info = classes.get(share.classId);
    if (info && share.claimable > 0n) claims.push({ info, source: { kind: "lienShare", lienId: share.lienId, classId: share.classId, amount: share.claimable, label: `Lien #${share.lienId.toString()} share` } });
  }
  for (const lot of retiredLots) {
    const info = classes.get(lot.classId);
    if (info && lot.claimable > 0n) {
      claims.push({ info, source: { kind: "retired", roundId: lot.roundId, classId: lot.classId, amount: lot.claimable, retireTo: lot.retireTo, label: `Tender #${lot.roundId.toString()} retired lot` } });
    }
  }
  return { base: claims.filter((claim) => claim.info.chain === "Base"), solana: claims.filter((claim) => claim.info.chain === "Solana") };
}

/** The engine's `ClaimSourceArgs` for a claim source. */
export function claimSourceArgs(source: ClaimSource): { Holding: { class_id: string } } | { Retired: { round_id: string } } | { LienShare: { lien_id: string } } {
  switch (source.kind) {
    case "holding":
      return { Holding: { class_id: source.classId } };
    case "retired":
      return { Retired: { round_id: source.roundId.toString() } };
    case "lienShare":
      return { LienShare: { lien_id: source.lienId.toString() } };
  }
}

export type CashRow = { cash: Cash; chain: "near" | "base" };

export function cashRows(cash: readonly Cash[]): CashRow[] {
  return cash.filter((entry) => entry.amount > 0n).map((entry) => ({ cash: entry, chain: entry.venue === "Near" ? "near" : "base" }));
}

export function cashIn(cash: readonly Cash[], venue: Venue): bigint {
  return cash.find((entry) => sameVenue(entry.venue, venue))?.amount ?? 0n;
}

export type PayoutState = "requested" | "stale" | "signed" | "unconfirmed" | "submitted" | "awaiting_gas" | "failed" | "lapsed";

/**
 * A signed payout on its own chain: `executed` (RoseVault used the id, the durable nonce
 * advanced, or the blockhash-signed transaction succeeded), `pending` (it can still be
 * submitted), `lapsed` (a blockhash-signed transaction that failed or expired: it can never
 * execute), or null when the chain could not be read.
 */
export type ForeignState = "executed" | "pending" | "lapsed" | null;

/**
 * Where a payout stands from the claimant's point of view. `stale` means the signature request
 * is older than the engine's pending expiry and can be re-requested; `unconfirmed` is a Solana
 * transfer or release whose nonce advanced but which the engine has not proven landed yet
 * (`confirm_sol_payout` / `confirm_sol_redeem`); `lapsed` is a deposit move or a return whose
 * transaction failed or whose blockhash expired (nothing was debited; the deposit page asks for
 * a new one).
 */
export function payoutState(payout: PayoutView, foreign: ForeignState, currentBlock: bigint | null, pendingExpiryBlocks = 600n): PayoutState {
  if (typeof payout.status === "object") return "failed";
  if (payout.status === "Landed") return "submitted";
  if (payout.status === "AwaitingGasSignature") return "awaiting_gas";
  if (payout.status === "Requested") {
    return currentBlock !== null && BigInt(payout.requested_block) + pendingExpiryBlocks <= currentBlock ? "stale" : "requested";
  }
  if (foreign === "lapsed") return "lapsed";
  if (foreign !== "executed") return "signed";
  return payout.chain === "Solana" && ("SolTransfer" in payout.kind || "SolRelease" in payout.kind) ? "unconfirmed" : "submitted";
}

/** Payouts that are settled one way or another: they belong to the history, not to the pending list. */
export function settledPayout(state: PayoutState): boolean {
  return state === "submitted" || state === "failed" || state === "lapsed";
}

/** Blocks after which a signature request that never answered can be retried (the engine's `PENDING_EXPIRY_BLOCKS`). */
const PENDING_EXPIRY_BLOCKS = 600n;
/** Blocks between a first "did not execute" proof's answer and the second proof (the engine's `CONFIRM_FAILURE_DELAY_BLOCKS`). */
const CONFIRM_FAILURE_DELAY_BLOCKS = 150n;
/** About 0.6 s per NEAR testnet block (spec 7.1: 200 blocks take about 2 min). */
const NEAR_BLOCK_MS = 600;

/** The line under a pending payout: what it waits for, and from which block the next action opens. */
export function pendingHint(payout: PayoutView, state: PayoutState, blockHeight: bigint): string | null {
  if (state === "requested") {
    const retryAt = BigInt(payout.requested_block) + PENDING_EXPIRY_BLOCKS;
    const left = retryAt > blockHeight ? retryAt - blockHeight : 0n;
    const minutes = Math.ceil((Number(left) * NEAR_BLOCK_MS) / 60_000);
    return `The MPC callback has not run yet: about 5 s, up to 2 min when a provider lags. If it never answers, "Retry signature" opens at block ${retryAt.toString()} (in about ${String(minutes)} min).`;
  }
  if (state === "unconfirmed") {
    const seen = payout.solana?.not_executed_seen_at;
    if (seen === undefined || seen === null) return "The nonce advanced on Solana; Confirm asks the MPC to prove the accounts so the engine settles the payout.";
    return `A first proof read the transaction as not executed. A second proof requested from block ${(BigInt(seen) + CONFIRM_FAILURE_DELAY_BLOCKS).toString()} settles it: landed, or refunded if it did not execute.`;
  }
  return null;
}

export type OrderRow = { bid: Bid; open: boolean };

/** The account's sealed orders, live ones first. */
export function orderRows(bids: readonly Bid[]): OrderRow[] {
  return bids
    .map((bid) => ({ bid, open: bid.status === "Sealed" || bid.status === "Opened" }))
    .sort((a, b) => Number(b.open) - Number(a.open) || (a.bid.roundId > b.bid.roundId ? -1 : 1));
}

export type LienProgress = { lien: Lien; remaining: bigint; percentDelivered: number; releasable: boolean };

export function lienProgress(liens: readonly Lien[]): LienProgress[] {
  return liens.map((lien) => {
    const remaining = lien.claimTotal > lien.delivered ? lien.claimTotal - lien.delivered : 0n;
    const percent = lien.claimTotal === 0n ? 100 : Number((lien.delivered * 10_000n) / lien.claimTotal) / 100;
    return { lien, remaining, percentDelivered: Math.min(100, percent), releasable: !lien.released && remaining === 0n };
  });
}

function mentions(value: unknown, account: string): boolean {
  if (typeof value === "string") return value === account;
  if (Array.isArray(value)) return value.some((item) => mentions(item, account));
  if (typeof value === "object" && value !== null) return Object.values(value).some((item) => mentions(item, account));
  return false;
}

/** Events the account appears in (as the caller or in the payload), newest first. */
export function accountEvents(events: readonly StoredEvent[], account: string): StoredEvent[] {
  return events.filter((entry) => entry.predecessor === account || mentions(entry.event.data, account)).sort((a, b) => (a.seq < b.seq ? 1 : -1));
}

export type HistoryEntry = { id: string; atMs: number; title: string; links: { href: string; label: string }[] };

/** The round ids an account's orders belong to, without duplicates. */
export function orderRoundIds(bids: readonly Bid[]): bigint[] {
  return [...new Set(bids.map((bid) => bid.roundId.toString()))].map((id) => BigInt(id));
}

export function eventTimeMs(event: StoredEvent): number {
  return nsToMs(event.timestamp);
}

/**
 * Why a position cannot be redeemed in kind now, or undefined: the redeem burns its whole
 * allocation from free units, and on Solana also takes what the stream still owes the unit
 * holders from the redeemer's claimable tokens (pending lien excess included; spec 7.3).
 */
export function redeemBlocker(position: { allocation: bigint }, freeUnits: bigint, solana: { owed: bigint; claimable: bigint } | null): string | undefined {
  if (position.allocation > freeUnits) return "Your free units do not cover this position's allocation";
  if (solana && solana.owed > solana.claimable) return "Your claimable tokens do not cover what the stream owes the unit holders";
  return undefined;
}

/** What `planSolDraws` reads of a `get_sol_streams` entry. */
export type DrawableStream = { position_id: string; withdrawable: string; stream: { net_amount_deposited: string; engine_withdrawn: string } };

/**
 * The streams a Solana claim of `amount` draws on, as `get_sol_streams` reports them now, with
 * the fewest streams (the 1,232-byte packet bounds the draws of one payout). The engine re-checks
 * every draw: at most the stream's withdrawable amount, and at least one whole token unless the
 * draw empties the stream. So each stream offers a range `[low, withdrawable]` (`low` = one token,
 * or the whole remainder of a stream it empties): the `k` largest streams can pay any amount
 * between the sum of their lows and the sum of their withdrawables; each draw starts at its low
 * and the rest is filled largest first.
 */
export function planSolDraws(streams: readonly DrawableStream[], amount: bigint, decimals: number): SolDrawArgs[] {
  const oneToken = 10n ** BigInt(decimals);
  const options = streams
    .map((entry) => {
      const withdrawable = BigInt(entry.withdrawable);
      const empties = BigInt(entry.stream.engine_withdrawn) + withdrawable === BigInt(entry.stream.net_amount_deposited);
      const low = withdrawable >= oneToken ? oneToken : empties ? withdrawable : null;
      return { positionId: entry.position_id, withdrawable, low };
    })
    .filter((option): option is { positionId: string; withdrawable: bigint; low: bigint } => option.low !== null && option.withdrawable > 0n)
    .sort((a, b) => (b.withdrawable > a.withdrawable ? 1 : b.withdrawable < a.withdrawable ? -1 : 0));
  let lows = 0n;
  let highs = 0n;
  for (let k = 0; k < options.length; k += 1) {
    lows += options[k]!.low;
    highs += options[k]!.withdrawable;
    if (lows > amount) break;
    if (highs < amount) continue;
    let extra = amount - lows;
    return options.slice(0, k + 1).map((option) => {
      const add = extra < option.withdrawable - option.low ? extra : option.withdrawable - option.low;
      extra -= add;
      return { position_id: option.positionId, amount: (option.low + add).toString() };
    });
  }
  throw new RoseActionError("contract", "Not withdrawable yet", "The class streams cannot pay this amount right now: each stream must give at least one whole token. Claim less or wait for the next unlock.");
}
