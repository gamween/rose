/**
 * Pure transforms behind the Rounds pages (spec 8.3): labels, number formatting, the status
 * timeline, the next action for whoever is looking at a round, and the fee, collateral and bond
 * previews shown before every order (spec 5.3, 5.5). Everything here is deterministic and
 * unit-tested; nothing touches the network.
 */

import { charge, fee, ONE, perClaimedToken, type Bid, type ClassInfo, type Pricing, type Round, type RoundKind, type RoundResult, type RoundStatus, type Venue } from "@rose/sdk";
import { NEAR_TUSDC_ACCOUNT } from "@/lib/deployment";
import type { ActionErrorKind } from "@/lib/errors";
import { formatCash, formatUnits } from "@/lib/format";
import { deployedCashSymbol } from "@/lib/token-symbols";

export const USDC_DECIMALS = 6;
export const ONE_USDC = 1_000_000n;
export const NS_PER_MS = 1_000_000n;
/** Gas burnt by one fully verified opening, measured live on the staging engine: 132 Tgas at 1e-4 NEAR per Tgas. */
export const OPENING_COST_NEAR = "0.0132";

export function nsToMs(ns: bigint): number {
  return Number(ns / NS_PER_MS);
}

export function msToNs(ms: number): bigint {
  return BigInt(Math.floor(ms)) * NS_PER_MS;
}

export function secondsToNs(seconds: number): bigint {
  return BigInt(Math.floor(seconds)) * 1_000_000_000n;
}

/** `7.20` USDC: at least two fraction digits, trailing zeros beyond them dropped, never rounded up. */
export const formatUsdc = formatCash;

/** Token quantities in whole tokens with up to four fraction digits (never rounded up). */
export function formatQty(units: bigint, decimals: number, maxDigits = 4): string {
  const full = formatUnits(units, decimals, maxDigits);
  const [whole, fraction = ""] = full.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length > 0 ? `${whole ?? "0"}.${trimmed}` : (whole ?? "0");
}

/** Parses a decimal string typed by the user into base units; null when it is not a number. */
export function parseDecimal(text: string, decimals: number): bigint | null {
  const clean = text.trim().replace(",", ".");
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") return null;
  const [whole = "0", fraction = ""] = clean.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((fraction || "0").padEnd(decimals, "0").slice(0, decimals) || "0");
}

export function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(ms)) + " UTC";
}

export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(ms));
}

/** `formatDateTime` for narrow screens: two-digit year, no seconds (`4 Nov 26, 16:50 UTC`). */
export function formatDateTimeShort(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(new Date(ms)) + " UTC";
}

/** `formatDate` for narrow screens: month and year (`Jul 2027`). */
export function formatDateShort(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(ms));
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${String(s)} s`;
  if (s < 3600) return `${String(Math.floor(s / 60))} min`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${String(h)} h ${String(m)} min` : `${String(h)} h`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return h > 0 ? `${String(d)} d ${String(h)} h` : `${String(d)} d`;
}

export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 2 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function shortAccount(accountId: string): string {
  return accountId.length > 28 ? `${accountId.slice(0, 14)}…${accountId.slice(-10)}` : accountId;
}

export const KIND_LABEL: Record<RoundKind, string> = { Tender: "Tender", Exit: "Exit", Advance: "Advance" };

export const KIND_BLURB: Record<RoundKind, string> = {
  Tender: "The issuer buys back units with a public budget and max price; holders submit sealed asks.",
  Exit: "Holders submit sealed asks, buyers submit sealed bids; one uniform clearing price.",
  Advance: "A holder sells a senior claim on future unlocks; funders submit sealed bids per claimed token.",
};

export type Tone = "neutral" | "ember" | "rose" | "success" | "warning" | "danger" | "info";

export const STATUS_TONE: Record<RoundStatus, Tone> = {
  Scheduled: "neutral",
  Open: "ember",
  KeyRequested: "warning",
  Revealing: "info",
  Clearing: "info",
  Settled: "success",
  Cancelled: "danger",
};

export const STATUS_LABEL: Record<RoundStatus, string> = {
  Scheduled: "Scheduled",
  Open: "Open",
  KeyRequested: "Key requested",
  Revealing: "Revealing",
  Clearing: "Clearing",
  Settled: "Settled",
  Cancelled: "Cancelled",
};

/** `tUSDC on Base`: the symbol of a deployed cash token, the short address otherwise (the full one goes in a tooltip, see `venueTokenAccount`). */
export function venueLabel(venue: Venue): string {
  if (venue === "Near") return "tUSDC on NEAR";
  return `${deployedCashSymbol(venue.Base.token) ?? shortHex(venue.Base.token)} on Base`;
}

export function venueChain(venue: Venue): "near" | "base" {
  return venue === "Near" ? "near" : "base";
}

export function venueTokenAccount(venue: Venue): string {
  return venue === "Near" ? NEAR_TUSDC_ACCOUNT : venue.Base.token;
}

export function sameVenue(a: Venue, b: Venue): boolean {
  if (a === "Near" || b === "Near") return a === b;
  return a.Base.token.toLowerCase() === b.Base.token.toLowerCase();
}

/** Schedule end of a class in seconds. */
export function scheduleEndSecs(cls: ClassInfo): number {
  return Number(cls.schedule.end);
}

/** `CINDR · Base · unlocks until 6 Aug 2027`; the symbol comes from the chain when known. */
export function classLabel(cls: ClassInfo, symbol: string | null): string {
  const token = symbol ?? shortHex(cls.token, 6, 4);
  return `${token} · ${cls.chain} · unlocks until ${formatDate(scheduleEndSecs(cls) * 1000)}`;
}

export function classShortLabel(cls: ClassInfo, symbol: string | null): string {
  return `${symbol ?? shortHex(cls.token, 6, 4)} · ${cls.chain}`;
}

/** Locked fraction of one unit at the round's settlement time, as a percentage string. */
export function lockedPercent(fTs: bigint): string {
  const locked = ONE - fTs;
  const bps = (locked * 10_000n) / ONE;
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

/** Unit pricing of a round for the clearing reference and the previews. */
export function roundPricing(round: Pick<Round, "kind" | "fTs">, decimals: number): Pricing {
  return round.kind === "Advance" ? perClaimedToken(decimals) : { lockedFractionE18: ONE - round.fTs, tokenDecimals: decimals };
}

export interface BuyPreview {
  /** Cash charged at the limit price for the whole quantity (rounded up), fees excluded. */
  charge: bigint;
  fee: bigint;
  /** `charge + fee`: the least escrow that keeps the bid valid at opening. */
  escrowRequired: bigint;
  /** `max(bond floor, escrow / 100)`, refunded on a valid opening. */
  bond: bigint;
  /** Cash debited from the ledger when the bid is placed: `escrow + bond`. */
  total: bigint;
}

export function bondFor(collateral: bigint, bondFloor: bigint = ONE_USDC): bigint {
  const pct = collateral / 100n;
  return pct > bondFloor ? pct : bondFloor;
}

/** Fee and collateral preview of a buy order (spec 5.5: 30 bps on top of the price). */
export function previewBuy(pricing: Pricing, quantity: bigint, limitPrice: bigint, escrow: bigint | null, bondFloor: bigint = ONE_USDC): BuyPreview {
  const charged = charge(pricing, quantity, limitPrice);
  const owed = fee(charged);
  const escrowRequired = charged + owed;
  const chosen = escrow === null || escrow < escrowRequired ? escrowRequired : escrow;
  const bond = bondFor(chosen, bondFloor);
  return { charge: charged, fee: owed, escrowRequired, bond, total: chosen + bond };
}

export interface SellPreview {
  /** The locked units valued at the round's public max price (what the bond is computed on). */
  valuation: bigint;
  bond: bigint;
  /** Proceeds at the minimum price for the sealed quantity, before any clearing. */
  proceedsAtMinimum: bigint;
}

export function previewSell(pricing: Pricing, units: bigint, quantity: bigint, minimumPrice: bigint, maxPrice: bigint, bondFloor: bigint = ONE_USDC): SellPreview {
  const valuation = charge(pricing, units, maxPrice);
  return { valuation, bond: bondFor(valuation, bondFloor), proceedsAtMinimum: charge(pricing, quantity, minimumPrice) };
}

/* Timeline and next action */

export type TimelineStepId = "open" | "key" | "reveal" | "clear" | "settle";

export interface TimelineStep {
  id: TimelineStepId;
  label: string;
  state: "done" | "active" | "upcoming" | "failed";
  /** Timestamp shown under the step, when known (ms). */
  at: number | null;
  detail: string | null;
}

export type NextAction =
  | { kind: "wait_open"; at: number }
  | { kind: "bid"; closesAt: number }
  | { kind: "close" }
  | { kind: "waiting_key"; since: number; cancelAt: number }
  | { kind: "cancel_no_key" }
  | { kind: "finalize"; remaining: number; until: number }
  | { kind: "wait_reveal"; until: number }
  | { kind: "clear" }
  | { kind: "settle"; pending: number }
  | { kind: "done" };

/**
 * How long after `close` the MPC key counts as late (it normally arrives in about 5 s): past this
 * the header says so, and the next-step card offers a new key request while `close` takes one.
 */
export const KEY_LATE_AFTER_MS = 30_000;

export const NEXT_ACTION_LABEL: Record<NextAction["kind"], string> = {
  wait_open: "Opens soon",
  bid: "Place an order",
  close: "Close round",
  waiting_key: "Waiting for the MPC key",
  cancel_no_key: "Cancel (no key)",
  finalize: "Open every order",
  wait_reveal: "Reveal window",
  clear: "Clear",
  settle: "Settle",
  done: "Done",
};

/**
 * `cancel_no_key` refuses while a key request is in flight: 250 blocks after the last `close`
 * (`KEY_REQUEST_FLIGHT_BLOCKS`, past the MPC's 200-block yield). The view exposes the close time,
 * not its block, so the app waits 250 blocks at 0.8 s, an upper bound of the testnet block time
 * (measured 0.58 s per block over 10,000 blocks on 2026-11-04).
 */
export const KEY_REQUEST_FLIGHT_NS = 250n * 800_000_000n;

/** When `cancel_no_key` opens: `closes_at + key_timeout`, and never before the last key request resolved. */
export function cancelNoKeyAt(round: Pick<Round, "closesAt" | "keyTimeout" | "closeRequestedAt">): bigint {
  const timeout = round.closesAt + round.keyTimeout;
  const flight = round.closeRequestedAt === null ? 0n : round.closeRequestedAt + KEY_REQUEST_FLIGHT_NS;
  return flight > timeout ? flight : timeout;
}

/** Whether `close` accepts the round now: an order-less round always closes (it is cancelled), a round with orders only before its key timeout. */
export function canClose(round: Pick<Round, "closesAt" | "keyTimeout" | "bidCount">, nowMs: number): boolean {
  const now = msToNs(nowMs);
  return now >= round.closesAt && (round.bidCount === 0 || now < round.closesAt + round.keyTimeout);
}

/** The one thing whoever is looking at the round can do now (spec 5.6: no keeper). */
export function nextAction(round: Round, nowMs: number): NextAction {
  const now = msToNs(nowMs);
  switch (round.status) {
    case "Scheduled":
      return { kind: "wait_open", at: nsToMs(round.opensAt) };
    case "Open":
      if (now < round.closesAt) return { kind: "bid", closesAt: nsToMs(round.closesAt) };
      return canClose(round, nowMs) ? { kind: "close" } : { kind: "cancel_no_key" };
    case "KeyRequested": {
      const cancelAt = cancelNoKeyAt(round);
      if (now >= cancelAt) return { kind: "cancel_no_key" };
      return { kind: "waiting_key", since: nsToMs(round.closeRequestedAt ?? round.closesAt), cancelAt: nsToMs(cancelAt) };
    }
    case "Revealing": {
      const until = nsToMs(round.revealEndsAt ?? round.closesAt);
      const remaining = round.bidCount - round.openedCount;
      return remaining > 0 ? { kind: "finalize", remaining, until } : { kind: "wait_reveal", until };
    }
    case "Clearing":
      return { kind: "clear" };
    case "Settled":
    case "Cancelled": {
      const pending = round.bidCount - round.settledCount;
      return pending > 0 ? { kind: "settle", pending } : { kind: "done" };
    }
  }
}

/** The orders the Settle action runs: the viewer's own unsettled orders, or every unsettled order when they have none. */
export function settleQueue(bids: readonly Bid[], viewer: string | null): { scope: "mine" | "all"; queue: Bid[] } {
  const pending = bids.filter((bid) => bid.status !== "Settled");
  const mine = viewer === null ? [] : pending.filter((bid) => bid.bidder === viewer);
  return mine.length > 0 ? { scope: "mine", queue: mine } : { scope: "all", queue: pending };
}

/**
 * Failures that stop a per-order run (opening or settling): every later order would fail the same
 * way (the wallet refused or has no balance, the RPC is unreachable or the demo account's presence
 * could not be checked), so the run ends instead of failing each remaining order in turn.
 */
const RUN_STOPPING_KINDS: ReadonlySet<ActionErrorKind> = new Set(["rejected", "no_wallet", "insufficient_balance", "rate_limited", "rpc"]);

export function stopsRun(kind: ActionErrorKind): boolean {
  return RUN_STOPPING_KINDS.has(kind);
}

/** Whether the creator can still withdraw the round (before any order and before the close). */
export function canCancelAsCreator(round: Round, viewer: string | null, nowMs: number): boolean {
  return viewer !== null && round.creator === viewer && round.status === "Open" && round.bidCount === 0 && msToNs(nowMs) < round.closesAt;
}

/** Whether the no-key cancellation is open (`closes_at + key_timeout` passed without a key, no key request in flight). */
export function canCancelNoKey(round: Round, nowMs: number): boolean {
  return (round.status === "Open" || round.status === "KeyRequested") && round.key === null && msToNs(nowMs) >= cancelNoKeyAt(round);
}

/**
 * The clearing of a round, only once it is `Settled`. A cancelled round also stores a result
 * (price 0, volume 0) so that its orders can settle their refunds: it never cleared.
 */
export function clearingOf(round: Pick<Round, "status" | "result">): RoundResult | null {
  return round.status === "Settled" ? round.result : null;
}

const STEP_LABEL: Record<TimelineStepId, string> = { open: "Open", key: "Key release", reveal: "Revealing", clear: "Clearing", settle: "Settled" };

/** Five steps from opening to settlement, with what happened at each (used by the status timeline). */
export function timeline(round: Round, nowMs: number, decimals = 18): TimelineStep[] {
  const order: TimelineStepId[] = ["open", "key", "reveal", "clear", "settle"];
  const activeIndex = activeStep(round, nowMs);
  const cancelled = round.status === "Cancelled";
  return order.map((id, index) => {
    const base = { id, label: STEP_LABEL[id], at: stepTime(round, id), detail: stepDetail(round, id, nowMs, decimals) };
    if (cancelled) {
      if (index < activeIndex) return { ...base, state: "done" as const };
      if (index === activeIndex) return { ...base, label: "Cancelled", state: "failed" as const };
      return { ...base, state: "upcoming" as const };
    }
    if (index < activeIndex) return { ...base, state: "done" as const };
    if (index === activeIndex) return { ...base, state: round.status === "Settled" ? ("done" as const) : ("active" as const) };
    return { ...base, state: "upcoming" as const };
  });
}

function activeStep(round: Round, nowMs: number): number {
  switch (round.status) {
    case "Scheduled":
    case "Open":
      return 0;
    case "KeyRequested":
      return 1;
    case "Revealing":
      return 2;
    case "Clearing":
      return 3;
    case "Settled":
      return 4;
    case "Cancelled": {
      if (round.cancelReason === "NoCrossing") return 3;
      if (round.cancelReason === "NoKey") return 1;
      if (round.cancelReason === "Empty") return 1;
      return msToNs(nowMs) < round.closesAt ? 0 : 1;
    }
  }
}

function stepTime(round: Round, id: TimelineStepId): number | null {
  switch (id) {
    case "open":
      return nsToMs(round.opensAt);
    case "key":
      return round.keyReceivedAt !== null ? nsToMs(round.keyReceivedAt) : round.closeRequestedAt !== null ? nsToMs(round.closeRequestedAt) : nsToMs(round.closesAt);
    case "reveal":
      return round.revealEndsAt !== null ? nsToMs(round.revealEndsAt) : null;
    case "clear":
      return round.status === "Settled" || (round.status === "Cancelled" && round.cancelReason === "NoCrossing") ? (round.endedAt !== null ? nsToMs(round.endedAt) : null) : null;
    case "settle":
      return round.status === "Settled" && round.bidCount === round.settledCount && round.endedAt !== null ? nsToMs(round.endedAt) : null;
  }
}

function stepDetail(round: Round, id: TimelineStepId, nowMs: number, decimals: number): string | null {
  switch (id) {
    case "open":
      return `${String(round.bidCount)} sealed ${round.bidCount === 1 ? "order" : "orders"} · closes ${formatDateTime(nsToMs(round.closesAt))}`;
    case "key": {
      if (round.keyReceivedAt !== null && round.closeRequestedAt !== null) {
        const latency = Number(round.keyReceivedAt - round.closeRequestedAt) / 1e9;
        return `${round.keySource === "Submitted" ? "submitted" : "MPC callback"} · ${latency.toFixed(1)} s after close`;
      }
      if (round.status === "Cancelled" && round.cancelReason === "NoKey") return "no key within the timeout";
      if (round.status === "Cancelled" && round.cancelReason === "Empty") return "closed without orders";
      if (round.status === "Cancelled") return "withdrawn by the creator";
      if (round.status === "KeyRequested") return `requested from the MPC · timeout ${formatDuration(Number(round.keyTimeout) / 1e9)}`;
      return `${formatDuration(Number(round.keyTimeout) / 1e9)} timeout after close`;
    }
    case "reveal":
      if (round.keyReceivedAt === null) return `${formatDuration(Number(round.revealWindow) / 1e9)} window`;
      return `${String(round.openedCount)} / ${String(round.bidCount)} opened · window ${formatDuration(Number(round.revealWindow) / 1e9)}`;
    case "clear": {
      if (round.status === "Cancelled") return round.cancelReason === "NoCrossing" ? "no price crossed the book" : "not reached · every order is refunded";
      const clearing = clearingOf(round);
      if (clearing) return `cleared at ${formatUsdc(clearing.price)} · volume ${formatQty(clearing.volume, decimals)}`;
      if (round.status === "Clearing") return "window closed · anyone can clear";
      return "computed on chain in one transaction";
    }
    case "settle": {
      const pending = round.bidCount - round.settledCount;
      if (round.status === "Settled" || round.status === "Cancelled") return pending > 0 ? `${String(pending)} ${pending === 1 ? "order" : "orders"} left to settle` : "every order settled";
      return nowMs > 0 ? "per order, by anyone" : null;
    }
  }
}

/** Progress of a round in [0, 1] for compact bars: time elapsed while open, then the step index. */
export function roundProgress(round: Round, nowMs: number): number {
  if (round.status === "Open" || round.status === "Scheduled") {
    const start = nsToMs(round.opensAt);
    const end = nsToMs(round.closesAt);
    if (end <= start) return 0;
    return Math.min(1, Math.max(0, (nowMs - start) / (end - start))) * 0.5;
  }
  return 0.5 + activeStep(round, nowMs) / 8;
}

/** A cancelled round stores a zero-price record so its orders can settle: show why it ended instead. */
export function cancelledOutcome(round: Round): string {
  if (round.cancelReason === "NoCrossing") return "No crossing";
  if (round.cancelReason === "NoKey") return "No key";
  if (round.cancelReason === "Empty") return "No orders";
  return "Withdrawn";
}
