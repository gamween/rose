/**
 * Typed view calls of the rose-engine contract. Every method maps one `view` function of the ABI
 * and returns the parsed shape (`bigint` amounts). Raw views are available through `raw`.
 *
 * @module
 */

import {
  parseBid,
  parseBuyQuote,
  parseCash,
  parseClass,
  parseEventsPage,
  parseHolding,
  parseLien,
  parseLienShare,
  parseLimits,
  parsePortfolio,
  parsePosition,
  parsePriceHistoryPage,
  parseRetiredLot,
  parseRound,
  parseRoundResult,
  parseRoundsPage,
  parseSellQuote,
  parseStats,
  parseU,
} from "./parse.js";
import { NearRpc } from "./rpc.js";
import type {
  AccountId,
  Bid,
  BidView,
  BuyQuote,
  BuyQuoteView,
  Cash,
  CashView,
  ClassId,
  ClassInfo,
  ClassView,
  ConfigView,
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
  PayoutView,
  Portfolio,
  PortfolioView,
  Position,
  PositionView,
  PriceHistoryPage,
  PriceHistoryPageView,
  RetiredLot,
  RefusedDepositView,
  ReplayKey,
  ReplayStateView,
  RetiredLotView,
  Round,
  RoundFilter,
  RoundResult,
  RoundResultView,
  RoundsPage,
  RoundsPageView,
  RoundView,
  SablierScheduleArgs,
  SellQuote,
  SellQuoteView,
  Side,
  SolDepositView,
  SolStreamInfoView,
  Stats,
  StorageBalance,
  StorageBalanceBoundsView,
  StorageBalanceView,
  StreamflowScheduleArgs,
  TokenView,
} from "./types.js";

export interface ViewCallOptions { signal?: AbortSignal }

type Id = bigint | number | string;

function id(value: Id): string {
  return typeof value === "string" ? value : value.toString();
}

/** Raw (`*View`) access to every view method, for callers that want the JSON as returned. */
export class EngineRawViews {
  constructor(
    readonly rpc: NearRpc,
    readonly account: AccountId,
  ) {}

  private async call<T>(method: string, args: Record<string, unknown>, options?: ViewCallOptions): Promise<T> {
    const { value } = await this.rpc.viewFunction<T>(this.account, method, args, options?.signal);
    return value;
  }

  stats(o?: ViewCallOptions): Promise<unknown> {
    return this.call("stats", {}, o);
  }
  getConfig(o?: ViewCallOptions): Promise<ConfigView> {
    return this.call("get_config", {}, o);
  }
  getLimits(o?: ViewCallOptions): Promise<LimitsView> {
    return this.call("get_limits", {}, o);
  }
  getClass(classId: ClassId, o?: ViewCallOptions): Promise<ClassView | null> {
    return this.call("get_class", { class_id: classId }, o);
  }
  getClasses(fromIndex?: number, limit?: number, o?: ViewCallOptions): Promise<ClassView[]> {
    return this.call("get_classes", { from_index: fromIndex ?? null, limit: limit ?? null }, o);
  }
  getPosition(positionId: Id, o?: ViewCallOptions): Promise<PositionView | null> {
    return this.call("get_position", { position_id: id(positionId) }, o);
  }
  getPositions(fromIndex?: Id, limit?: number, o?: ViewCallOptions): Promise<PositionView[]> {
    return this.call("get_positions", { from_index: fromIndex === undefined ? null : id(fromIndex), limit: limit ?? null }, o);
  }
  getRound(roundId: Id, o?: ViewCallOptions): Promise<RoundView | null> {
    return this.call("get_round", { round_id: id(roundId) }, o);
  }
  getRounds(filter?: RoundFilter, fromIndex?: Id, limit?: number, o?: ViewCallOptions): Promise<RoundsPageView> {
    return this.call("get_rounds", { filter: filter ?? null, from_index: fromIndex === undefined ? null : id(fromIndex), limit: limit ?? null }, o);
  }
  getBids(roundId: Id, o?: ViewCallOptions): Promise<BidView[]> {
    return this.call("get_bids", { round_id: id(roundId) }, o);
  }
  getBid(roundId: Id, bidId: number, o?: ViewCallOptions): Promise<BidView | null> {
    return this.call("get_bid", { round_id: id(roundId), bid_id: bidId }, o);
  }
  getOrderId(roundId: Id, account: AccountId, side: Side, o?: ViewCallOptions): Promise<number | null> {
    return this.call("get_order_id", { round_id: id(roundId), account, side }, o);
  }
  getRoundResult(roundId: Id, o?: ViewCallOptions): Promise<RoundResultView | null> {
    return this.call("get_round_result", { round_id: id(roundId) }, o);
  }
  getHolding(account: AccountId, classId: ClassId, o?: ViewCallOptions): Promise<HoldingView> {
    return this.call("get_holding", { account, class_id: classId }, o);
  }
  getRetiredLot(roundId: Id, o?: ViewCallOptions): Promise<RetiredLotView | null> {
    return this.call("get_retired_lot", { round_id: id(roundId) }, o);
  }
  getPortfolio(account: AccountId, o?: ViewCallOptions): Promise<PortfolioView> {
    return this.call("get_portfolio", { account }, o);
  }
  getCash(account: AccountId, o?: ViewCallOptions): Promise<CashView[]> {
    return this.call("get_cash", { account }, o);
  }
  getLiens(account: AccountId, o?: ViewCallOptions): Promise<[LienView[], LienShareView[]]> {
    return this.call("get_liens", { account }, o);
  }
  getLien(lienId: Id, o?: ViewCallOptions): Promise<LienView | null> {
    return this.call("get_lien", { lien_id: id(lienId) }, o);
  }
  getPriceHistory(classId: ClassId, fromIndex?: number, limit?: number, o?: ViewCallOptions): Promise<PriceHistoryPageView> {
    return this.call("get_price_history", { class_id: classId, from_index: fromIndex ?? null, limit: limit ?? null }, o);
  }
  getEvents(fromSeq?: Id, limit?: number, o?: ViewCallOptions): Promise<EventsPageView> {
    return this.call("get_events", { from_seq: fromSeq === undefined ? null : id(fromSeq), limit: limit ?? null }, o);
  }
  quoteBuy(roundId: Id, quantity: bigint, limitPrice: bigint, o?: ViewCallOptions): Promise<BuyQuoteView> {
    return this.call("quote_buy", { round_id: id(roundId), quantity: quantity.toString(), limit_price: limitPrice.toString() }, o);
  }
  quoteSell(roundId: Id, units: bigint, o?: ViewCallOptions): Promise<SellQuoteView> {
    return this.call("quote_sell", { round_id: id(roundId), units: units.toString() }, o);
  }
  getClaimable(account: AccountId, classId: ClassId, o?: ViewCallOptions): Promise<string> {
    return this.call("get_claimable", { account, class_id: classId }, o);
  }
  mtBalanceOf(accountId: AccountId, tokenId: string, o?: ViewCallOptions): Promise<string> {
    return this.call("mt_balance_of", { account_id: accountId, token_id: tokenId }, o);
  }
  mtBatchBalanceOf(accountId: AccountId, tokenIds: string[], o?: ViewCallOptions): Promise<string[]> {
    return this.call("mt_batch_balance_of", { account_id: accountId, token_ids: tokenIds }, o);
  }
  mtSupply(tokenId: string, o?: ViewCallOptions): Promise<string | null> {
    return this.call("mt_supply", { token_id: tokenId }, o);
  }
  mtBatchSupply(tokenIds: string[], o?: ViewCallOptions): Promise<(string | null)[]> {
    return this.call("mt_batch_supply", { token_ids: tokenIds }, o);
  }
  mtToken(tokenIds: string[], o?: ViewCallOptions): Promise<(TokenView | null)[]> {
    return this.call("mt_token", { token_ids: tokenIds }, o);
  }
  storageBalanceBounds(o?: ViewCallOptions): Promise<StorageBalanceBoundsView> {
    return this.call("storage_balance_bounds", {}, o);
  }
  storageBalanceOf(accountId: AccountId, o?: ViewCallOptions): Promise<StorageBalanceView | null> {
    return this.call("storage_balance_of", { account_id: accountId }, o);
  }
  getPayout(payoutId: Id, o?: ViewCallOptions): Promise<PayoutView | null> {
    return this.call("get_payout", { payout_id: id(payoutId) }, o);
  }
  getPayouts(account: AccountId, fromIndex?: number, limit?: number, o?: ViewCallOptions): Promise<PayoutView[]> {
    return this.call("get_payouts", { account, from_index: fromIndex ?? null, limit: limit ?? null }, o);
  }
  payoutsTotal(o?: ViewCallOptions): Promise<string> {
    return this.call("payouts_total", {}, o);
  }
  getPendingRelease(positionId: Id, o?: ViewCallOptions): Promise<string | null> {
    return this.call("get_pending_release", { position_id: id(positionId) }, o);
  }
  getRefusedDeposit(key: ReplayKey, o?: ViewCallOptions): Promise<RefusedDepositView | null> {
    return this.call("get_refused_deposit", { key }, o);
  }
  getReplay(key: ReplayKey, o?: ViewCallOptions): Promise<ReplayStateView | null> {
    return this.call("get_replay", { key }, o);
  }
  getSolDeposit(metadata: string, o?: ViewCallOptions): Promise<SolDepositView | null> {
    return this.call("get_sol_deposit", { metadata }, o);
  }
  getSolStream(positionId: Id, o?: ViewCallOptions): Promise<SolStreamInfoView | null> {
    return this.call("get_sol_stream", { position_id: id(positionId) }, o);
  }
  /** NEP-145 deposit (yoctoNEAR) a deposit registration must attach for `account` to hold `classId`. */
  registrationDepositFor(account: AccountId, classId: ClassId, o?: ViewCallOptions): Promise<string> {
    return this.call("registration_deposit_for", { account, class_id: classId }, o);
  }
  computeBaseClassId(token: string, decimals: number, schedule: SablierScheduleArgs, o?: ViewCallOptions): Promise<ClassId> {
    return this.call("compute_base_class_id", { token, decimals, schedule }, o);
  }
  computeSolClassId(mint: string, decimals: number, schedule: StreamflowScheduleArgs, o?: ViewCallOptions): Promise<ClassId> {
    return this.call("compute_sol_class_id", { mint, decimals, schedule }, o);
  }
  /** `dep/<account>/<class_id>`, the MPC derivation path of the holder's Solana deposit address. */
  depositPathOf(account: AccountId, classId: ClassId, o?: ViewCallOptions): Promise<string> {
    return this.call("deposit_path_of", { account, class_id: classId }, o);
  }
}

/** Parsed access to every view method of the engine. */
export class EngineViews {
  readonly raw: EngineRawViews;

  constructor(rpc: NearRpc, account: AccountId) {
    this.raw = new EngineRawViews(rpc, account);
  }

  get account(): AccountId {
    return this.raw.account;
  }

  async stats(o?: ViewCallOptions): Promise<Stats> {
    return parseStats(await this.raw.stats(o));
  }
  getConfig(o?: ViewCallOptions): Promise<ConfigView> {
    return this.raw.getConfig(o);
  }
  async getLimits(o?: ViewCallOptions): Promise<Limits> {
    return parseLimits(await this.raw.getLimits(o));
  }
  async getClass(classId: ClassId, o?: ViewCallOptions): Promise<ClassInfo | null> {
    const view = await this.raw.getClass(classId, o);
    return view ? parseClass(view) : null;
  }
  async getClasses(fromIndex?: number, limit?: number, o?: ViewCallOptions): Promise<ClassInfo[]> {
    return (await this.raw.getClasses(fromIndex, limit, o)).map(parseClass);
  }
  async getPosition(positionId: Id, o?: ViewCallOptions): Promise<Position | null> {
    const view = await this.raw.getPosition(positionId, o);
    return view ? parsePosition(view) : null;
  }
  async getPositions(fromIndex?: Id, limit?: number, o?: ViewCallOptions): Promise<Position[]> {
    return (await this.raw.getPositions(fromIndex, limit, o)).map(parsePosition);
  }
  async getRound(roundId: Id, o?: ViewCallOptions): Promise<Round | null> {
    const view = await this.raw.getRound(roundId, o);
    return view ? parseRound(view) : null;
  }
  /** One page of rounds; pass `next` back as `fromIndex` to continue (the engine scans at most 200 ids per call). */
  async getRounds(filter?: RoundFilter, fromIndex?: Id, limit?: number, o?: ViewCallOptions): Promise<RoundsPage> {
    return parseRoundsPage(await this.raw.getRounds(filter, fromIndex, limit, o));
  }
  async getBids(roundId: Id, o?: ViewCallOptions): Promise<Bid[]> {
    return (await this.raw.getBids(roundId, o)).map(parseBid);
  }
  async getBid(roundId: Id, bidId: number, o?: ViewCallOptions): Promise<Bid | null> {
    const view = await this.raw.getBid(roundId, bidId, o);
    return view ? parseBid(view) : null;
  }
  getOrderId(roundId: Id, account: AccountId, side: Side, o?: ViewCallOptions): Promise<number | null> {
    return this.raw.getOrderId(roundId, account, side, o);
  }
  async getRoundResult(roundId: Id, o?: ViewCallOptions): Promise<RoundResult | null> {
    const view = await this.raw.getRoundResult(roundId, o);
    return view ? parseRoundResult(view) : null;
  }
  async getHolding(account: AccountId, classId: ClassId, o?: ViewCallOptions): Promise<Holding> {
    return parseHolding(await this.raw.getHolding(account, classId, o));
  }
  async getRetiredLot(roundId: Id, o?: ViewCallOptions): Promise<RetiredLot | null> {
    const view = await this.raw.getRetiredLot(roundId, o);
    return view ? parseRetiredLot(view) : null;
  }
  async getPortfolio(account: AccountId, o?: ViewCallOptions): Promise<Portfolio> {
    return parsePortfolio(await this.raw.getPortfolio(account, o));
  }
  async getCash(account: AccountId, o?: ViewCallOptions): Promise<Cash[]> {
    return (await this.raw.getCash(account, o)).map(parseCash);
  }
  async getLiens(account: AccountId, o?: ViewCallOptions): Promise<{ held: Lien[]; shares: LienShare[] }> {
    const [held, shares] = await this.raw.getLiens(account, o);
    return { held: held.map(parseLien), shares: shares.map(parseLienShare) };
  }
  async getLien(lienId: Id, o?: ViewCallOptions): Promise<Lien | null> {
    const view = await this.raw.getLien(lienId, o);
    return view ? parseLien(view) : null;
  }
  async getPriceHistory(classId: ClassId, fromIndex?: number, limit?: number, o?: ViewCallOptions): Promise<PriceHistoryPage> {
    return parsePriceHistoryPage(await this.raw.getPriceHistory(classId, fromIndex, limit, o));
  }
  async getEvents(fromSeq?: Id, limit?: number, o?: ViewCallOptions): Promise<EventsPage> {
    return parseEventsPage(await this.raw.getEvents(fromSeq, limit, o));
  }
  async quoteBuy(roundId: Id, quantity: bigint, limitPrice: bigint, o?: ViewCallOptions): Promise<BuyQuote> {
    return parseBuyQuote(await this.raw.quoteBuy(roundId, quantity, limitPrice, o));
  }
  async quoteSell(roundId: Id, units: bigint, o?: ViewCallOptions): Promise<SellQuote> {
    return parseSellQuote(await this.raw.quoteSell(roundId, units, o));
  }
  async getClaimable(account: AccountId, classId: ClassId, o?: ViewCallOptions): Promise<bigint> {
    return parseU(await this.raw.getClaimable(account, classId, o), "claimable");
  }
  async mtBalanceOf(accountId: AccountId, tokenId: string, o?: ViewCallOptions): Promise<bigint> {
    return parseU(await this.raw.mtBalanceOf(accountId, tokenId, o), "mt_balance_of");
  }
  async mtBatchBalanceOf(accountId: AccountId, tokenIds: string[], o?: ViewCallOptions): Promise<bigint[]> {
    return (await this.raw.mtBatchBalanceOf(accountId, tokenIds, o)).map((value) => parseU(value, "mt_batch_balance_of"));
  }
  async mtSupply(tokenId: string, o?: ViewCallOptions): Promise<bigint | null> {
    const value = await this.raw.mtSupply(tokenId, o);
    return value === null ? null : parseU(value, "mt_supply");
  }
  /** Minimum NEP-145 deposit to hold units (`min`); `max` is unbounded. */
  async storageMinimum(o?: ViewCallOptions): Promise<bigint> {
    return parseU((await this.raw.storageBalanceBounds(o)).min, "storage_balance_bounds.min");
  }
  async storageBalanceOf(accountId: AccountId, o?: ViewCallOptions): Promise<StorageBalance | null> {
    const view = await this.raw.storageBalanceOf(accountId, o);
    return view ? { total: parseU(view.total, "storage.total"), available: parseU(view.available, "storage.available") } : null;
  }
  getPayout(payoutId: Id, o?: ViewCallOptions): Promise<PayoutView | null> {
    return this.raw.getPayout(payoutId, o);
  }
  getPayouts(account: AccountId, fromIndex?: number, limit?: number, o?: ViewCallOptions): Promise<PayoutView[]> {
    return this.raw.getPayouts(account, fromIndex, limit, o);
  }
  async payoutsTotal(o?: ViewCallOptions): Promise<bigint> {
    return parseU(await this.raw.payoutsTotal(o), "payouts_total");
  }
  async registrationDepositFor(account: AccountId, classId: ClassId, o?: ViewCallOptions): Promise<bigint> {
    return parseU(await this.raw.registrationDepositFor(account, classId, o), "registration_deposit_for");
  }
}

/** Convenience: views of the engine at `account` through the default testnet RPC. */
export function engineViews(account: AccountId, rpc: NearRpc = new NearRpc()): EngineViews {
  return new EngineViews(rpc, account);
}
