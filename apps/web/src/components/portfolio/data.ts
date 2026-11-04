/**
 * Everything the Portfolio page reads, in one fetch: the engine views of the account, the class
 * list, the account's payouts with their foreign-chain state, the retired lots of its Tenders,
 * its NEP-145 storage, token symbols from Base and the account's slice of the event history.
 */

import { isAuthorizationUsed, readNonceAccount, type ClassInfo, type ConfigView, type PayoutView, type Portfolio, type Position, type RetiredLot, type Round, type StorageBalance, type StoredEvent } from "@rose/sdk";
import { PublicKey } from "@solana/web3.js";
import { deployedAddress } from "@/lib/deployment";
import { readEventRange } from "@/lib/event-pages";
import { blockhashActionState, isBlockhashAction } from "@/lib/payouts";
import { requireEngine, nearRpc } from "@/lib/engine-client";
import { tokenSymbols } from "@/lib/token-symbols";
import { basePublicClient } from "@/lib/wallet/evm-demo";
import { solanaConnection } from "@/lib/wallet/solana-demo";
import { accountEvents, orderRoundIds, payoutState, type ForeignState, type PayoutState } from "./transforms";

const PAGE = 50;
const EVENTS_WINDOW = 400;

export type PayoutEntry = { payout: PayoutView; state: PayoutState };

export type PortfolioData = {
  account: string;
  config: ConfigView;
  classes: Map<string, ClassInfo>;
  portfolio: Portfolio;
  /** Held positions of the classes the account holds free units of (candidates for an in-kind redeem). */
  positions: Position[];
  /** Claimable tokens a Solana redeem of each candidate position takes now (`get_sol_streams` `redeem_claimable`), by position id. */
  redeemOwed: Map<string, bigint>;
  retiredLots: RetiredLot[];
  rounds: Map<string, Round>;
  payouts: PayoutEntry[];
  storage: StorageBalance | null;
  storageMinimum: bigint;
  symbols: Map<string, string>;
  events: StoredEvent[];
  blockHeight: bigint;
  /** Timestamp (seconds) of the block the views were read at: the "now" every amount is valued at. */
  blockTimeSec: bigint;
};

async function allClasses(signal: AbortSignal): Promise<Map<string, ClassInfo>> {
  const { views } = requireEngine();
  const classes = new Map<string, ClassInfo>();
  for (let from = 0; ; from += PAGE) {
    const page = await views.getClasses(from, PAGE, { signal });
    for (const info of page) classes.set(info.classId, info);
    if (page.length < PAGE) return classes;
  }
}

async function heldPositions(classIds: ReadonlySet<string>, signal: AbortSignal): Promise<Position[]> {
  if (classIds.size === 0) return [];
  const { views } = requireEngine();
  const held: Position[] = [];
  for (let from = 0n; ; from += BigInt(PAGE)) {
    const page = await views.getPositions(from, PAGE, { signal });
    for (const position of page) if (position.state === "Held" && classIds.has(position.classId)) held.push(position);
    if (page.length < PAGE) return held;
  }
}

async function retiredLotsOf(account: string, signal: AbortSignal): Promise<RetiredLot[]> {
  const { views } = requireEngine();
  const lots: RetiredLot[] = [];
  let from: bigint | undefined;
  for (;;) {
    const page = await views.getRounds({ kind: "Tender", creator: account }, from, PAGE, { signal });
    for (const round of page.rounds) {
      if (round.status !== "Settled") continue;
      const lot = await views.getRetiredLot(round.roundId, { signal });
      if (lot) lots.push(lot);
    }
    if (page.next === null) return lots;
    from = page.next;
  }
}

async function accountPayouts(account: string, signal: AbortSignal): Promise<PayoutView[]> {
  const { views } = requireEngine();
  const payouts: PayoutView[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await views.getPayouts(account, from, PAGE, { signal });
    payouts.push(...page);
    if (page.length < PAGE) return payouts.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
  }
}

/**
 * Where a signed payout stands on its own chain (null when that cannot be read): RoseVault's
 * replay bitmap on Base, the advanced nonce of a durable-nonce Solana action, and the signature
 * status (or the expired blockhash) of a deposit move or a refused-deposit return.
 */
async function payoutForeign(payout: PayoutView): Promise<ForeignState> {
  if (payout.status !== "Signed") return null;
  try {
    if (payout.chain === "Base") {
      const vault = deployedAddress("roseVault");
      if (!vault) return null;
      return (await isAuthorizationUsed(basePublicClient(), vault, BigInt(payout.id))) ? "executed" : "pending";
    }
    if (isBlockhashAction(payout)) {
      const state = await blockhashActionState(solanaConnection(), payout);
      return state === "executed" ? "executed" : state === "pending" ? "pending" : "lapsed";
    }
    const nonceAccount = payout.solana?.nonce_account;
    const nonceValue = payout.solana?.nonce_value;
    if (!nonceAccount || !nonceValue) return null;
    const state = await readNonceAccount(solanaConnection(), new PublicKey(nonceAccount), "confirmed");
    return state.nonce !== nonceValue ? "executed" : "pending";
  } catch {
    return null;
  }
}

async function recentEvents(account: string, signal: AbortSignal): Promise<StoredEvent[]> {
  const { views } = requireEngine();
  const latest = await views.getEvents(undefined, 1, { signal });
  const from = latest.total > BigInt(EVENTS_WINDOW) ? latest.total - BigInt(EVENTS_WINDOW) : 0n;
  const page = await readEventRange((fromSeq, limit) => views.getEvents(fromSeq, limit, { signal }), from > latest.oldest ? from : latest.oldest, EVENTS_WINDOW);
  return accountEvents(page.events, account);
}

/** Reads the whole portfolio of `account`; throws `EngineNotDeployedError` while the engine is not deployed. */
export async function fetchPortfolioData(account: string, signal: AbortSignal): Promise<PortfolioData> {
  const { views } = requireEngine();
  const [config, classes, portfolio, payoutsRaw, storage, storageMinimum, block, events] = await Promise.all([
    views.getConfig({ signal }),
    allClasses(signal),
    views.getPortfolio(account, { signal }),
    accountPayouts(account, signal),
    views.storageBalanceOf(account, { signal }),
    views.storageMinimum({ signal }),
    nearRpc().block("final", signal),
    recentEvents(account, signal),
  ]);
  const heldClassIds = new Set(portfolio.holdings.filter((holding) => holding.balance > 0n).map((holding) => holding.classId));
  const roundIds = orderRoundIds(portfolio.bids);
  const solanaClassIds = [...heldClassIds].filter((classId) => classes.get(classId)?.chain === "Solana");
  const [positions, retiredLots, roundList, foreign, solStreams] = await Promise.all([
    heldPositions(heldClassIds, signal),
    retiredLotsOf(account, signal),
    Promise.all(roundIds.map((roundId) => views.getRound(roundId, { signal }))),
    Promise.all(payoutsRaw.map(payoutForeign)),
    Promise.all(solanaClassIds.map((classId) => views.getSolStreams(classId, { signal }))),
  ]);
  const symbols = await tokenSymbols([
    ...[...classes.values()].map((info) => ({ chain: info.chain, token: info.token })),
    ...config.base_cash_tokens.map((token) => ({ chain: "Base" as const, token })),
    ...portfolio.cash.flatMap((entry) => (entry.venue === "Near" ? [] : [{ chain: "Base" as const, token: entry.venue.Base.token }])),
  ]);
  const blockHeight = BigInt(block.header.height);
  const rounds = new Map<string, Round>();
  roundList.forEach((round) => {
    if (round) rounds.set(round.roundId.toString(), round);
  });
  return {
    account,
    config,
    classes,
    portfolio,
    positions,
    redeemOwed: new Map(solStreams.flat().map((entry) => [entry.position_id, BigInt(entry.redeem_claimable)])),
    retiredLots,
    rounds,
    payouts: payoutsRaw.map((payout, index) => ({ payout, state: payoutState(payout, foreign[index] ?? null, blockHeight) })),
    storage,
    storageMinimum,
    symbols,
    events,
    blockHeight,
    blockTimeSec: BigInt(block.header.timestamp_nanosec) / 1_000_000_000n,
  };
}
