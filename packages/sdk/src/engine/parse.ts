/**
 * Conversions from the raw view JSON (`*View`) to the parsed types with `bigint`.
 *
 * @module
 */

import type {
  Bid,
  BidOutcome,
  BidOutcomeView,
  BidView,
  BuyQuote,
  BuyQuoteView,
  Cash,
  CashView,
  ClassInfo,
  ClassSchedule,
  ClassView,
  EventsPage,
  EventsPageView,
  Holding,
  HoldingView,
  Lien,
  LienShare,
  LienShareView,
  LienView,
  Limits,
  LimitsView,
  Portfolio,
  PortfolioView,
  Position,
  PositionSource,
  PositionSourceView,
  PositionView,
  PriceHistoryPage,
  PriceHistoryPageView,
  PricePoint,
  PricePointView,
  RetiredLot,
  RetiredLotView,
  Round,
  RoundResult,
  RoundResultView,
  RoundsPage,
  RoundsPageView,
  RoundView,
  RoseEventView,
  ScheduleView,
  SellQuote,
  SellQuoteView,
  Stats,
  StatsView,
  StoredEvent,
  StoredEventView,
} from "./types.js";

/** Error for a view payload that does not have the shape the ABI promises. */
export class EngineParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineParseError";
  }
}

/** Parses a near-sdk `U128`/`U64` decimal string. */
export function parseU(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new EngineParseError(`${field} is not an integer string.`);
  return BigInt(value);
}

function parseOptionalU(value: unknown, field: string): bigint | null {
  return value === null || value === undefined ? null : parseU(value, field);
}

function parseCounter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new EngineParseError(`${field} is not a counter.`);
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EngineParseError(`${field} is not an object.`);
  return value as Record<string, unknown>;
}

export function parseStats(raw: unknown): Stats {
  const view = object(raw, "stats") as Partial<StatsView>;
  return {
    roundsTotal: parseCounter(view.rounds_total, "stats.rounds_total"),
    roundsSettled: parseCounter(view.rounds_settled, "stats.rounds_settled"),
    volumeSettledUsdc: parseU(view.volume_settled_usdc, "stats.volume_settled_usdc"),
    classes: parseCounter(view.classes, "stats.classes"),
    positions: parseCounter(view.positions, "stats.positions"),
  };
}

export function parseLimits(view: LimitsView): Limits {
  return {
    bidStorageDeposit: parseU(view.bid_storage_deposit, "limits.bid_storage_deposit"),
    roundStorageDeposit: parseU(view.round_storage_deposit, "limits.round_storage_deposit"),
    bondFloor: parseU(view.bond_floor, "limits.bond_floor"),
    feeBps: parseCounter(view.fee_bps, "limits.fee_bps"),
    maxBidsPerRound: parseCounter(view.max_bids_per_round, "limits.max_bids_per_round"),
    maxDistributionReceivers: parseCounter(view.max_distribution_receivers, "limits.max_distribution_receivers"),
    minKeyTimeout: parseU(view.min_key_timeout, "limits.min_key_timeout"),
    maxKeyTimeout: parseU(view.max_key_timeout, "limits.max_key_timeout"),
    minRevealWindow: parseU(view.min_reveal_window, "limits.min_reveal_window"),
    maxRevealWindow: parseU(view.max_reveal_window, "limits.max_reveal_window"),
    maxRoundHorizon: parseU(view.max_round_horizon, "limits.max_round_horizon"),
  };
}

export function parseSchedule(view: ScheduleView): ClassSchedule {
  if ("Linear" in view) {
    const s = view.Linear;
    return {
      kind: "Linear",
      start: parseU(s.start, "schedule.start"),
      cliff: parseU(s.cliff, "schedule.cliff"),
      end: parseU(s.end, "schedule.end"),
      granularity: parseU(s.granularity, "schedule.granularity"),
      total: parseU(s.total, "schedule.total"),
      startUnlock: parseU(s.start_unlock, "schedule.start_unlock"),
      cliffUnlock: parseU(s.cliff_unlock, "schedule.cliff_unlock"),
      minDeposit: parseU(s.min_deposit, "schedule.min_deposit"),
    };
  }
  const s = view.Stepped;
  return {
    kind: "Stepped",
    start: parseU(s.start, "schedule.start"),
    end: parseU(s.end, "schedule.end"),
    period: parseU(s.period, "schedule.period"),
    amountPerPeriod: parseU(s.amount_per_period, "schedule.amount_per_period"),
    cliffAmount: parseU(s.cliff_amount, "schedule.cliff_amount"),
    total: parseU(s.total, "schedule.total"),
  };
}

export function parseClass(view: ClassView): ClassInfo {
  return {
    classId: view.class_id,
    chain: view.chain,
    token: view.token,
    tokenRisk: view.token_risk,
    decimals: parseCounter(view.decimals, "class.decimals"),
    schedule: parseSchedule(view.schedule),
    totalUnits: parseU(view.total_units, "class.total_units"),
    positions: parseCounter(view.positions, "class.positions"),
    createdAt: parseU(view.created_at, "class.created_at"),
    fractionNow: parseU(view.fraction_now, "class.fraction_now"),
  };
}

export function parsePositionSource(view: PositionSourceView): PositionSource {
  if ("BaseStream" in view) {
    return { kind: "BaseStream", lockup: view.BaseStream.lockup, streamId: parseU(view.BaseStream.stream_id, "position.source.stream_id") };
  }
  return { kind: "SolanaStream", metadata: view.SolanaStream.metadata };
}

export function parsePosition(view: PositionView): Position {
  return {
    positionId: parseU(view.position_id, "position.position_id"),
    classId: view.class_id,
    source: parsePositionSource(view.source),
    allocation: parseU(view.allocation, "position.allocation"),
    depositor: view.depositor,
    depositedAt: parseU(view.deposited_at, "position.deposited_at"),
    state: view.state,
  };
}

function parseOpened(view: { quantity: string; price: string } | null | undefined): { quantity: bigint; price: bigint } | null {
  if (!view) return null;
  return { quantity: parseU(view.quantity, "opened.quantity"), price: parseU(view.price, "opened.price") };
}

export function parseBid(view: BidView): Bid {
  return {
    roundId: parseU(view.round_id, "bid.round_id"),
    bidId: parseCounter(view.bid_id, "bid.bid_id"),
    bidder: view.bidder,
    side: view.side,
    status: view.status,
    escrow: parseU(view.escrow, "bid.escrow"),
    lockedUnits: parseU(view.locked_units, "bid.locked_units"),
    bond: parseU(view.bond, "bid.bond"),
    fee: parseU(view.fee, "bid.fee"),
    cash: parseU(view.cash, "bid.cash"),
    fillQuantity: parseU(view.fill_quantity, "bid.fill_quantity"),
    ciphertextHex: view.ciphertext_hex ?? null,
    placedAt: parseOptionalU(view.placed_at, "bid.placed_at"),
    opened: parseOpened(view.opened),
    void: view.void ?? null,
  };
}

export function parseBidOutcome(view: BidOutcomeView): BidOutcome {
  return {
    bidId: parseCounter(view.bid_id, "fill.bid_id"),
    bidder: view.bidder,
    side: view.side,
    escrow: parseU(view.escrow, "fill.escrow"),
    lockedUnits: parseU(view.locked_units, "fill.locked_units"),
    bond: parseU(view.bond, "fill.bond"),
    fee: parseU(view.fee, "fill.fee"),
    cash: parseU(view.cash, "fill.cash"),
    fillQuantity: parseU(view.fill_quantity, "fill.fill_quantity"),
    settled: view.settled,
    opened: parseOpened(view.opened),
    void: view.void ?? null,
  };
}

export function parseRoundResult(view: RoundResultView): RoundResult {
  return {
    price: parseU(view.price, "result.price"),
    volume: parseU(view.volume, "result.volume"),
    notional: parseU(view.notional, "result.notional"),
    fee: parseU(view.fee, "result.fee"),
    issuerCharged: parseU(view.issuer_charged, "result.issuer_charged"),
    issuerRefund: parseU(view.issuer_refund, "result.issuer_refund"),
    remainingLockSecs: parseU(view.remaining_lock_secs, "result.remaining_lock_secs"),
    fills: view.fills.map(parseBidOutcome),
  };
}

export function parseRound(view: RoundView): Round {
  return {
    roundId: parseU(view.round_id, "round.round_id"),
    kind: view.kind,
    classId: view.class_id,
    venue: view.venue,
    creator: view.creator,
    status: view.status,
    appId: view.app_id,
    opensAt: parseU(view.opens_at, "round.opens_at"),
    closesAt: parseU(view.closes_at, "round.closes_at"),
    keyTimeout: parseU(view.key_timeout, "round.key_timeout"),
    revealWindow: parseU(view.reveal_window, "round.reveal_window"),
    maxPrice: parseU(view.max_price, "round.max_price"),
    fTs: parseU(view.f_ts, "round.f_ts"),
    remainingLockSecs: parseU(view.remaining_lock_secs, "round.remaining_lock_secs"),
    bidCount: parseCounter(view.bid_count, "round.bid_count"),
    openedCount: parseCounter(view.opened_count, "round.opened_count"),
    settledCount: parseCounter(view.settled_count, "round.settled_count"),
    createdAt: parseU(view.created_at, "round.created_at"),
    budget: parseOptionalU(view.budget, "round.budget"),
    issuerEscrow: parseOptionalU(view.issuer_escrow, "round.issuer_escrow"),
    referencePrice: parseOptionalU(view.reference_price, "round.reference_price"),
    maxBuyQuantity: parseOptionalU(view.max_buy_quantity, "round.max_buy_quantity"),
    retireTo: view.retire_to ?? null,
    advanceUnits: parseOptionalU(view.advance_units, "round.advance_units"),
    advanceClaim: parseOptionalU(view.advance_claim, "round.advance_claim"),
    advanceMinFill: parseOptionalU(view.advance_min_fill, "round.advance_min_fill"),
    lienId: parseOptionalU(view.lien_id, "round.lien_id"),
    closeRequestedAt: parseOptionalU(view.close_requested_at, "round.close_requested_at"),
    key: view.key ?? null,
    keySource: view.key_source ?? null,
    keyReceivedAt: parseOptionalU(view.key_received_at, "round.key_received_at"),
    revealEndsAt: parseOptionalU(view.reveal_ends_at, "round.reveal_ends_at"),
    endedAt: parseOptionalU(view.ended_at, "round.ended_at"),
    cancelReason: view.cancel_reason ?? null,
    result: view.result ? parseRoundResult(view.result) : null,
  };
}

export function parseHolding(view: HoldingView): Holding {
  return {
    classId: view.class_id,
    balance: parseU(view.balance, "holding.balance"),
    lockedInRounds: parseU(view.locked_in_rounds, "holding.locked_in_rounds"),
    encumbered: parseU(view.encumbered, "holding.encumbered"),
    claimable: parseU(view.claimable, "holding.claimable"),
    checkpoint: parseU(view.checkpoint, "holding.checkpoint"),
  };
}

export function parseCash(view: CashView): Cash {
  return { venue: view.venue, amount: parseU(view.amount, "cash.amount") };
}

export function parseLien(view: LienView): Lien {
  return {
    lienId: parseU(view.lien_id, "lien.lien_id"),
    roundId: parseU(view.round_id, "lien.round_id"),
    classId: view.class_id,
    holder: view.holder,
    units: parseU(view.units, "lien.units"),
    claimTotal: parseU(view.claim_total, "lien.claim_total"),
    delivered: parseU(view.delivered, "lien.delivered"),
    pendingExcess: parseU(view.pending_excess, "lien.pending_excess"),
    createdAt: parseU(view.created_at, "lien.created_at"),
    released: view.released,
  };
}

export function parseLienShare(view: LienShareView): LienShare {
  return {
    lienId: parseU(view.lien_id, "share.lien_id"),
    classId: view.class_id,
    funder: view.funder,
    claim: parseU(view.claim, "share.claim"),
    claimed: parseU(view.claimed, "share.claimed"),
    claimable: parseU(view.claimable, "share.claimable"),
  };
}

export function parsePortfolio(view: PortfolioView): Portfolio {
  return {
    holdings: view.holdings.map(parseHolding),
    bids: view.bids.map(parseBid),
    liensHeld: view.liens_held.map(parseLien),
    lienShares: view.lien_shares.map(parseLienShare),
    cash: view.cash.map(parseCash),
  };
}

export function parseRetiredLot(view: RetiredLotView): RetiredLot {
  return {
    roundId: parseU(view.round_id, "lot.round_id"),
    classId: view.class_id,
    retireTo: view.retire_to,
    units: parseU(view.units, "lot.units"),
    claimable: parseU(view.claimable, "lot.claimable"),
  };
}

export function parsePricePoint(view: PricePointView): PricePoint {
  return {
    roundId: parseCounter(view.round_id, "price.round_id"),
    kind: view.kind,
    price: parseU(view.price, "price.price"),
    volume: parseU(view.volume, "price.volume"),
    remainingLockSecs: parseU(view.remaining_lock_secs, "price.remaining_lock_secs"),
    settledAt: parseU(view.settled_at, "price.settled_at"),
  };
}

export function parsePriceHistoryPage(view: PriceHistoryPageView): PriceHistoryPage {
  return { points: view.points.map(parsePricePoint), total: parseCounter(view.total, "price_history.total") };
}

export function parseRoundsPage(view: RoundsPageView): RoundsPage {
  return { rounds: view.rounds.map(parseRound), next: parseOptionalU(view.next, "rounds.next") };
}

export function parseBuyQuote(view: BuyQuoteView): BuyQuote {
  return {
    charge: parseU(view.charge, "quote.charge"),
    fee: parseU(view.fee, "quote.fee"),
    bond: parseU(view.bond, "quote.bond"),
    escrowRequired: parseU(view.escrow_required, "quote.escrow_required"),
  };
}

export function parseSellQuote(view: SellQuoteView): SellQuote {
  return { valuation: parseU(view.valuation, "quote.valuation"), bond: parseU(view.bond, "quote.bond") };
}

export function parseStoredEvent(view: StoredEventView): StoredEvent {
  const { seq, block_height, timestamp, predecessor, ...event } = view;
  if (typeof event.event !== "string") throw new EngineParseError("event.event is not a string.");
  // Unit variants (`bootstrap_requested`, `bootstrap_failed`) are serialized without `data`.
  const data: unknown = (event as { data?: unknown }).data ?? {};
  return {
    seq: parseU(seq, "event.seq"),
    blockHeight: parseU(block_height, "event.block_height"),
    timestamp: parseU(timestamp, "event.timestamp"),
    predecessor,
    event: { event: event.event, data } as RoseEventView,
  };
}

export function parseEventsPage(view: EventsPageView): EventsPage {
  return { events: view.events.map(parseStoredEvent), total: parseU(view.total, "events.total"), oldest: parseU(view.oldest, "events.oldest") };
}
