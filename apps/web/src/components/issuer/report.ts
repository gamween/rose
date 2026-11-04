/**
 * The exportable Tender report (guide-issuer.md, step 8): parameters, the sealed book, every
 * opened ask, the candidate price table (`S(P)`, affordable quantity, `Q(P)`) recomputed in the
 * browser with the `@rose/sdk` clearing reference, `P*`, fills, fee, refund and links.
 */

import { affordable, ONE, tender, type Bid, type ClassInfo, type Order, type Pricing, type Round, type RoundResult, type StoredEvent } from "@rose/sdk";
import { formatAmount, formatDate, formatUsdc, nsToMs, venueLabel } from "@/lib/amounts";
import { nearAccountUrl } from "@/lib/explorer";

export type CandidateRow = { price: bigint; supply: bigint; affordable: bigint; volume: bigint; best: boolean };

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

function csvCell(value: string | number | bigint | boolean | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function csvRows(rows: (string | number | bigint | boolean | null)[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

/** The whole report as one CSV with a `section` first column, so a spreadsheet keeps every table. */
export function tenderReportCsv(data: TenderReportData): string {
  const { round, cls, result, bids, symbol } = data;
  const pricing = pricingOf(round, cls);
  const asks = askOrders(bids);
  const budget = round.budget ?? 0n;
  const candidates = candidateTable(asks, budget, round.maxPrice, pricing);
  const sections: (string | number | bigint | boolean | null)[][] = [
    ["section", "field", "value", "", "", "", ""],
    ["parameters", "engine", data.engine],
    ["parameters", "round_id", round.roundId.toString()],
    ["parameters", "class_id", round.classId],
    ["parameters", "class", `${symbol} ${cls.chain}`],
    ["parameters", "venue", venueLabel(round.venue)],
    ["parameters", "creator", round.creator],
    ["parameters", "status", round.status],
    ["parameters", "budget_cash_base_units", budget.toString()],
    ["parameters", "budget", formatUsdc(budget)],
    ["parameters", "max_price_per_locked_token", formatUsdc(round.maxPrice, 6)],
    ["parameters", "reference_price", round.referencePrice === null ? "" : formatUsdc(round.referencePrice, 6)],
    ["parameters", "retire_to", round.retireTo ?? ""],
    ["parameters", "opens_at_utc", formatDate(nsToMs(round.opensAt))],
    ["parameters", "closes_at_utc", formatDate(nsToMs(round.closesAt))],
    ["parameters", "f_ts", round.fTs.toString()],
    ["parameters", "remaining_lock_secs", round.remainingLockSecs.toString()],
    ["parameters", "key_source", round.keySource ?? ""],
    ["parameters", "key_received_at_utc", round.keyReceivedAt === null ? "" : formatDate(nsToMs(round.keyReceivedAt))],
    ["sealed_book", "sealed_asks", bids.length],
    ["sealed_book", "locked_units_total", bids.reduce((sum, bid) => sum + bid.lockedUnits, 0n).toString()],
    ["sealed_book", "bonds_total", formatUsdc(bids.reduce((sum, bid) => sum + bid.bond, 0n))],
    ["asks", "bid_id", "bidder", "locked_units", "quantity", "min_price", "status"],
    ...bids.map((bid) => ["asks", bid.bidId, bid.bidder, formatAmount(bid.lockedUnits, cls.decimals), bid.opened ? formatAmount(bid.opened.quantity, cls.decimals) : "", bid.opened ? formatUsdc(bid.opened.price, 6) : "", bid.void ?? bid.status]),
    ["candidates", "price", "supply_S", "affordable", "volume_Q", "best", ""],
    ...candidates.map((row) => ["candidates", formatUsdc(row.price, 6), formatAmount(row.supply, cls.decimals), formatAmount(row.affordable, cls.decimals), formatAmount(row.volume, cls.decimals), row.best, ""]),
  ];
  if (result) {
    sections.push(
      ["result", "clearing_price", formatUsdc(result.price, 6)],
      ["result", "volume_units", formatAmount(result.volume, cls.decimals)],
      ["result", "notional", formatUsdc(result.notional)],
      ["result", "fee", formatUsdc(result.fee)],
      ["result", "issuer_charged", formatUsdc(result.issuerCharged)],
      ["result", "issuer_refund", formatUsdc(result.issuerRefund)],
      ["fills", "bid_id", "bidder", "fill_quantity", "cash", "settled", "void"],
      ...result.fills.map((fill) => ["fills", fill.bidId, fill.bidder, formatAmount(fill.fillQuantity, cls.decimals), formatUsdc(fill.cash), fill.settled, fill.void ?? ""]),
    );
  }
  sections.push(
    ["events", "seq", "event", "timestamp_utc", "predecessor", "explorer", ""],
    ...data.events.map((entry) => ["events", entry.seq.toString(), entry.event.event, formatDate(nsToMs(entry.timestamp)), entry.predecessor, nearAccountUrl(entry.predecessor), ""]),
    ["generated", "at_utc", formatDate(data.generatedAt)],
  );
  return csvRows(sections);
}

/** The engine events that concern one round (`round_id` in their data). */
export function eventsOfRound(events: readonly StoredEvent[], roundId: bigint): StoredEvent[] {
  const id = roundId.toString();
  return events.filter((entry) => (entry.event.data as { round_id?: string }).round_id === id);
}
