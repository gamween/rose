/**
 * The exportable Tender report (guide-issuer.md, step 8): parameters, the sealed book, every
 * opened ask, the candidate price table (`S(P)`, affordable quantity, `Q(P)`) recomputed in the
 * browser with the `@rose/sdk` clearing reference, `P*`, fills, fee, refund and links.
 */

import { affordable, ONE, tender, type Bid, type ClassInfo, type Order, type Pricing, type Round, type RoundResult, type StoredEvent } from "@rose/sdk";
import { amountToText, nsToMs, venueLabel } from "@/lib/amounts";
import { USDC_DECIMALS } from "@/lib/engine";
import { nearAccountUrl } from "@/lib/explorer";

/** Settled or cancelled, with every order settled: nothing in the report can change any more. */
export function isFinalRound(round: Pick<Round, "status" | "bidCount" | "settledCount">): boolean {
  return (round.status === "Settled" || round.status === "Cancelled") && round.settledCount >= round.bidCount;
}

export type CandidateRow ={ price: bigint; supply: bigint; affordable: bigint; volume: bigint; best: boolean };

export type Recomputed = { outcome: "cleared"; price: bigint; volume: bigint; charged: bigint; refund: bigint; matches: boolean | null } | { outcome: "no_crossing"; matches: boolean | null };

export function pricingOf(round: Round, cls: ClassInfo): Pricing {
  return { lockedFractionE18: ONE - round.fTs, tokenDecimals: cls.decimals };
}

/** The opened, non-void asks as clearing orders (ids are the bid ids). */
export function askOrders(bids: readonly Bid[]): Order[] {
  return bids.filter((bid) => bid.side === "Sell" && bid.opened !== null && bid.void === null).map((bid) => ({ id: BigInt(bid.bidId), qty: bid.opened!.quantity, price: bid.opened!.price }));
}

/** `S(P)`, the affordable quantity and `Q(P) = min(S(P), affordable)` at every candidate price `<= maxPrice`. */
export function candidateTable(asks: readonly Order[], budget: bigint, maxPrice: bigint, pricing: Pricing): CandidateRow[] {
  const prices = [...new Set(asks.filter((ask) => ask.price <= maxPrice).map((ask) => ask.price))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rows = prices.map((price) => {
    const supply = asks.filter((ask) => ask.price <= price).reduce((sum, ask) => sum + ask.qty, 0n);
    const bound = affordable(pricing, budget, price);
    return { price, supply, affordable: bound, volume: supply < bound ? supply : bound, best: false };
  });
  let best: CandidateRow | null = null;
  for (const row of rows) if (best === null || row.volume > best.volume) best = row;
  if (best && best.volume > 0n) best.best = true;
  return rows;
}

/** Recomputes the clearing with the SDK reference and compares it with the on-chain result. */
export function recompute(asks: readonly Order[], budget: bigint, maxPrice: bigint, pricing: Pricing, result: RoundResult | null): Recomputed {
  const outcome = tender({ asks, budget, maxPrice, pricing });
  if (outcome.outcome === "no_crossing") return { outcome: "no_crossing", matches: result === null ? null : result.volume === 0n };
  const matches = result === null ? null : result.price === outcome.price && result.volume === outcome.volume;
  return { outcome: "cleared", price: outcome.price, volume: outcome.volume, charged: outcome.charged, refund: outcome.refund, matches };
}

export type TenderReportData = {
  engine: string;
  round: Round;
  cls: ClassInfo;
  symbol: string;
  bids: Bid[];
  result: RoundResult | null;
  events: StoredEvent[];
  generatedAt: number;
};

/** A plain decimal number: what the amount columns hold, which a spreadsheet must keep reading as a number. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
/** First characters that make a spreadsheet read a cell as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One RFC 4180 cell. Text from the chain (account ids, token symbols any ERC-20 sets) that a
 * spreadsheet would run as a formula gets a leading `'`; plain numbers stay numbers (they cannot
 * carry a formula, and every amount of the report is non-negative anyway).
 */
export function csvCell(value: string | number | bigint | boolean | null): string {
  const raw = value === null ? "" : String(value);
  const text = typeof value === "string" && FORMULA_START.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function csvRows(rows: (string | number | bigint | boolean | null)[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The whole report as one CSV with a `section` first column, so a spreadsheet keeps every table.
 * Machine-readable: amounts are exact decimals without separators or rounding (units with the
 * class decimals, cash and prices in USDC with 6 decimals), times are ISO 8601 in UTC, and the
 * unit of each column is in its name.
 */
export function tenderReportCsv(data: TenderReportData): string {
  const { round, cls, result, bids, symbol } = data;
  const pricing = pricingOf(round, cls);
  const asks = askOrders(bids);
  const budget = round.budget ?? 0n;
  const candidates = candidateTable(asks, budget, round.maxPrice, pricing);
  const units = (amount: bigint) => amountToText(amount, cls.decimals);
  const usdc = (amount: bigint) => amountToText(amount, USDC_DECIMALS);
  const sections: (string | number | bigint | boolean | null)[][] = [
    ["section", "field", "value", "", "", "", ""],
    ["parameters", "engine", data.engine],
    ["parameters", "round_id", round.roundId.toString()],
    ["parameters", "class_id", round.classId],
    ["parameters", "class", `${symbol} ${cls.chain}`],
    ["parameters", "token_decimals", cls.decimals],
    ["parameters", "venue", venueLabel(round.venue)],
    ["parameters", "creator", round.creator],
    ["parameters", "status", round.status],
    ["parameters", "budget_usdc", usdc(budget)],
    ["parameters", "max_price_usdc_per_locked_token", usdc(round.maxPrice)],
    ["parameters", "reference_price_usdc_per_locked_token", round.referencePrice === null ? "" : usdc(round.referencePrice)],
    ["parameters", "retire_to", round.retireTo ?? ""],
    ["parameters", "opens_at_utc", iso(nsToMs(round.opensAt))],
    ["parameters", "closes_at_utc", iso(nsToMs(round.closesAt))],
    ["parameters", "f_ts_e18", round.fTs.toString()],
    ["parameters", "remaining_lock_secs", round.remainingLockSecs.toString()],
    ["parameters", "key_source", round.keySource ?? ""],
    ["parameters", "key_received_at_utc", round.keyReceivedAt === null ? "" : iso(nsToMs(round.keyReceivedAt))],
    ["sealed_book", "sealed_asks", bids.length],
    ["sealed_book", "locked_units_total", units(bids.reduce((sum, bid) => sum + bid.lockedUnits, 0n))],
    ["sealed_book", "bonds_total_usdc", usdc(bids.reduce((sum, bid) => sum + bid.bond, 0n))],
    ["asks", "bid_id", "bidder", "locked_units", "quantity_units", "min_price_usdc", "status"],
    ...bids.map((bid) => ["asks", bid.bidId, bid.bidder, units(bid.lockedUnits), bid.opened ? units(bid.opened.quantity) : "", bid.opened ? usdc(bid.opened.price) : "", bid.void ?? bid.status]),
    ["candidates", "price_usdc", "supply_S_units", "affordable_units", "volume_Q_units", "best", ""],
    ...candidates.map((row) => ["candidates", usdc(row.price), units(row.supply), units(row.affordable), units(row.volume), row.best, ""]),
  ];
  if (result) {
    sections.push(
      ["result", "clearing_price_usdc_per_locked_token", usdc(result.price)],
      ["result", "volume_units", units(result.volume)],
      ["result", "notional_usdc", usdc(result.notional)],
      ["result", "fee_usdc", usdc(result.fee)],
      ["result", "issuer_charged_usdc", usdc(result.issuerCharged)],
      ["result", "issuer_refund_usdc", usdc(result.issuerRefund)],
      ["fills", "bid_id", "bidder", "fill_quantity_units", "cash_usdc", "settled", "void"],
      ...result.fills.map((fill) => ["fills", fill.bidId, fill.bidder, units(fill.fillQuantity), usdc(fill.cash), fill.settled, fill.void ?? ""]),
    );
  }
  sections.push(
    ["events", "seq", "event", "timestamp_utc", "predecessor", "explorer", "block"],
    ...data.events.map((entry) => ["events", entry.seq.toString(), entry.event.event, iso(nsToMs(entry.timestamp)), entry.predecessor, nearAccountUrl(entry.predecessor), entry.blockHeight.toString()]),
    ["generated", "at_utc", iso(data.generatedAt)],
  );
  return csvRows(sections);
}

/**
 * Events that only carry a round id as a label, not as an action on the round: `depositCash`
 * takes a free `roundId` earmark (0 when none was given, and 0 is a real round), so a
 * `base_cash_registered` event says nothing about the round it names.
 */
const EARMARK_ONLY_EVENTS = new Set(["base_cash_registered"]);

/** The engine events that concern one round (`round_id` in their data). */
export function eventsOfRound(events: readonly StoredEvent[], roundId: bigint): StoredEvent[] {
  const id = roundId.toString();
  return events.filter((entry) => !EARMARK_ONLY_EVENTS.has(entry.event.event) && (entry.event.data as { round_id?: string }).round_id === id);
}
