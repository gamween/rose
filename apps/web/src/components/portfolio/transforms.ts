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

export type PayoutState = "requested" | "stale" | "signed" | "unconfirmed" | "submitted" | "awaiting_gas" | "failed";

/**
 * Where a payout stands from the claimant's point of view. `submitted` comes from the foreign
 * chain (RoseVault's replay bitmap or the advanced nonce); `stale` means the signature request
 * is older than the engine's pending expiry and can be re-requested; `unconfirmed` is a Solana
 * transfer or release whose nonce advanced but which the engine has not proven landed yet
 * (`confirm_sol_payout` / `confirm_sol_redeem`).
 */
export function payoutState(payout: PayoutView, submitted: boolean | null, currentBlock: bigint | null, pendingExpiryBlocks = 600n): PayoutState {
  if (typeof payout.status === "object") return "failed";
  if (payout.status === "Landed") return "submitted";
  if (payout.status === "AwaitingGasSignature") return "awaiting_gas";
  if (payout.status === "Requested") {
    return currentBlock !== null && BigInt(payout.requested_block) + pendingExpiryBlocks <= currentBlock ? "stale" : "requested";
  }
  if (!submitted) return "signed";
  return payout.chain === "Solana" && ("SolTransfer" in payout.kind || "SolRelease" in payout.kind) ? "unconfirmed" : "submitted";
}

/** Payouts that still need something from the claimant (submission, broadcast, a re-signature). */
export function actionablePayouts(payouts: readonly { payout: PayoutView; state: PayoutState }[]): { payout: PayoutView; state: PayoutState }[] {
  return payouts.filter((entry) => entry.state === "signed" || entry.state === "unconfirmed" || entry.state === "awaiting_gas" || entry.state === "stale");
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

/** What `planSolDraws` reads of a `get_sol_streams` entry. */
export type DrawableStream = { position_id: string; withdrawable: string; stream: { net_amount_deposited: number; engine_withdrawn: number } };

/**
 * The streams a Solana claim of `amount` draws on: largest withdrawable first, as `get_sol_streams`
 * reports them now. The engine re-checks every draw: at most the stream's withdrawable amount, and
 * at least one whole token unless the draw empties the stream.
 */
export function planSolDraws(streams: readonly DrawableStream[], amount: bigint, decimals: number): SolDrawArgs[] {
  const oneToken = 10n ** BigInt(decimals);
  const draws: SolDrawArgs[] = [];
  let left = amount;
  for (const entry of [...streams].sort((a, b) => (BigInt(b.withdrawable) > BigInt(a.withdrawable) ? 1 : -1))) {
    if (left === 0n) break;
    const withdrawable = BigInt(entry.withdrawable);
    const take = withdrawable < left ? withdrawable : left;
    const empties = BigInt(entry.stream.engine_withdrawn) + take === BigInt(entry.stream.net_amount_deposited);
    if (take === 0n || (take < oneToken && !empties)) continue;
    draws.push({ position_id: entry.position_id, amount: take.toString() });
    left -= take;
  }
  if (left > 0n) {
    throw new RoseActionError("contract", "Not withdrawable yet", "The class streams cannot pay this amount right now: each stream must give at least one whole token. Claim less or wait for the next unlock.");
  }
  return draws;
}
