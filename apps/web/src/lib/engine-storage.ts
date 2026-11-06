/**
 * The engine's NEP-145 storage, as the app needs it before a voluntary receipt (spec 4, Unit):
 * a NEAR cash deposit (`ft_transfer_call`) needs room for a cash row in the `Near` venue, an
 * Exit bid needs room for the holding row of the class it buys. The engine charges every row
 * at its measured size for the longest account id (`contracts/engine/src/storage.rs`): record
 * 137 bytes, holding row 310 bytes, cash row 172 bytes (plus 159 bytes for a Base cash token
 * outside `config.base_cash_tokens`, its entry in the account's list of such venues), at the
 * protocol's 1e19 yoctoNEAR per byte; `storage_balance_bounds().min` (619 bytes, 0.00619 NEAR)
 * covers the record, one holding row and one cash row. An open Exit buy also keeps the holding
 * row it may create reserved until it settles (`reserved_row_bytes` of `place_bid`).
 *
 * The engine exposes the deposit (`storage_balance_of.total`) and what exceeds both the bytes in
 * use and the minimum (`available`), not the bytes themselves. When `available` is positive and
 * `total - available` exceeds the minimum, the bytes in use follow exactly; otherwise they are
 * rebuilt from the account's rows as `get_portfolio` lists them (a holding row exists while its
 * balance or stored claimable is non-zero, a cash row while its balance is non-zero), counting
 * a reserved row for every open Exit buy. The bid view does not say whether the bidder already
 * held a row of the class when it bid, so the rebuild is an upper bound: at worst the app asks
 * for one row more than needed, which stays withdrawable, rather than letting the call fail.
 */

import { CASH_ROW_STORAGE_DEPOSIT, type EngineViews, type Portfolio, type RoundKind, type StorageBalance, type Venue } from "@rose/sdk";
import { sameVenue } from "./amounts";

/** NEAR protocol storage price, yoctoNEAR per byte (`storage_amount_per_byte`). */
export const STORAGE_BYTE_COST = 10n ** 19n;
/** `STORAGE_ACCOUNT_BYTES` of the engine. */
export const STORAGE_RECORD_BYTES = 137n;
/** `HOLDING_ROW_BYTES` of the engine (the row and its entry in the account's class list). */
export const HOLDING_ROW_BYTES = 310n;
/** `CASH_ROW_BYTES` of the engine (`CASH_ROW_STORAGE_DEPOSIT` of the SDK, in bytes). */
export const CASH_ROW_BYTES = CASH_ROW_STORAGE_DEPOSIT / STORAGE_BYTE_COST;
/** `OTHER_VENUE_ENTRY_BYTES` of the engine, 40 + (1 + 4 + 64) + 4 + (4 + 42): paid with each cash row of a Base token outside the accepted list. */
export const OTHER_VENUE_ENTRY_BYTES = 159n;

/** What the account must attach to `storage_deposit` before the action, or null when its deposit already covers it. */
export type StorageNeed = { kind: "register" | "top_up"; deposit: bigint };

/** The rows an action adds: a cash row in `cashVenue`, a holding row of `classId` (each only when the account has none yet). */
export type StorageChange = { cashVenue?: Venue; classId?: string };

/** The engine facts the byte count needs beyond the portfolio. */
export type StorageContext = {
  /** `config.base_cash_tokens`: a Base cash row of another token also pays `OTHER_VENUE_ENTRY_BYTES`. */
  baseCashTokens: readonly string[];
  /** The Exit rounds among the rounds of the account's open buy bids (each such bid reserves a holding row). */
  exitRoundIds: ReadonlySet<bigint>;
};

type Rows = Pick<Portfolio, "holdings" | "cash" | "bids">;

/** Bytes of a cash row of `venue` (`cash_row_bytes` of the engine). */
export function cashRowBytes(venue: Venue, context: Pick<StorageContext, "baseCashTokens">): bigint {
  if (venue === "Near") return CASH_ROW_BYTES;
  const token = venue.Base.token.toLowerCase();
  return context.baseCashTokens.some((accepted) => accepted.toLowerCase() === token) ? CASH_ROW_BYTES : CASH_ROW_BYTES + OTHER_VENUE_ENTRY_BYTES;
}

function openBuys(portfolio: Pick<Portfolio, "bids">) {
  return portfolio.bids.filter((bid) => bid.side === "Buy" && bid.status !== "Settled");
}

/** Rows of the account that the engine charges, rebuilt from its portfolio (an upper bound, see the module note). */
export function chargedBytes(portfolio: Rows, context: StorageContext): bigint {
  const holdings = portfolio.holdings.filter((holding) => holding.balance > 0n || holding.claimable > 0n).length;
  const cash = portfolio.cash.filter((entry) => entry.amount > 0n).reduce((sum, entry) => sum + cashRowBytes(entry.venue, context), 0n);
  const reserved = openBuys(portfolio).filter((bid) => context.exitRoundIds.has(bid.roundId)).length;
  return STORAGE_RECORD_BYTES + BigInt(holdings + reserved) * HOLDING_ROW_BYTES + cash;
}

/** Bytes the account uses: exact from `storage_balance_of` when it tells, otherwise the rebuild (capped at the minimum when the deposit shows the usage is below it). */
export function usedBytes(input: { storage: StorageBalance; minimum: bigint; portfolio: Rows; context: StorageContext }): bigint {
  const { storage, minimum, portfolio, context } = input;
  const rebuilt = chargedBytes(portfolio, context);
  if (storage.available <= 0n) return rebuilt;
  const floor = storage.total - storage.available;
  if (floor > minimum) return floor / STORAGE_BYTE_COST;
  const cap = minimum / STORAGE_BYTE_COST;
  return rebuilt < cap ? rebuilt : cap;
}

/** Bytes the change adds to the account's rows. */
export function addedBytes(portfolio: Pick<Portfolio, "holdings" | "cash">, change: StorageChange, context: Pick<StorageContext, "baseCashTokens">): bigint {
  let bytes = 0n;
  if (change.cashVenue !== undefined) {
    const venue = change.cashVenue;
    const row = portfolio.cash.find((entry) => sameVenue(entry.venue, venue));
    if (!row || row.amount === 0n) bytes += cashRowBytes(venue, context);
  }
  if (change.classId !== undefined) {
    const row = portfolio.holdings.find((holding) => holding.classId === change.classId);
    if (!row || (row.balance === 0n && row.claimable === 0n)) bytes += HOLDING_ROW_BYTES;
  }
  return bytes;
}

/**
 * The deposit the engine's capacity check (`require_storage_capacity`) needs: the minimum for an
 * account that is not registered (it covers one holding and one cash row), otherwise what its
 * deposit misses for its rows plus the new ones. The check runs even when no row is added, so an
 * account the engine registered with a zero deposit (an owed credit) tops up its existing rows.
 */
export function storageNeed(input: { storage: StorageBalance | null; minimum: bigint; portfolio: Rows; change: StorageChange; context: StorageContext }): StorageNeed | null {
  const { storage, minimum, portfolio, change, context } = input;
  const added = addedBytes(portfolio, change, context);
  if (storage === null) {
    const required = (STORAGE_RECORD_BYTES + added) * STORAGE_BYTE_COST;
    return { kind: "register", deposit: required > minimum ? required : minimum };
  }
  const required = (usedBytes({ storage, minimum, portfolio, context }) + added) * STORAGE_BYTE_COST;
  return required > storage.total ? { kind: "top_up", deposit: required - storage.total } : null;
}

/**
 * Reads what the byte count needs beyond the portfolio: the accepted Base cash tokens (only when a
 * Base cash row is involved) and the kind of every round the account has an open buy bid in.
 * `known` lists rounds the caller already read, `config` the config it already holds.
 */
export async function readStorageContext(
  views: Pick<EngineViews, "getConfig" | "getRound">,
  portfolio: Rows,
  change: StorageChange,
  options: { signal?: AbortSignal; config?: { base_cash_tokens: string[] }; known?: readonly { roundId: bigint; kind: RoundKind }[] } = {},
): Promise<StorageContext> {
  const { signal, known = [] } = options;
  const needsConfig = portfolio.cash.some((entry) => entry.venue !== "Near" && entry.amount > 0n) || (change.cashVenue !== undefined && change.cashVenue !== "Near");
  const roundIds = [...new Set(openBuys(portfolio).map((bid) => bid.roundId))];
  const unknown = roundIds.filter((id) => !known.some((round) => round.roundId === id));
  const [config, rounds] = await Promise.all([
    needsConfig ? (options.config ?? views.getConfig({ signal })) : Promise.resolve({ base_cash_tokens: [] as string[] }),
    Promise.all(unknown.map((id) => views.getRound(id, { signal }))),
  ]);
  const kinds = [...known, ...rounds.flatMap((round) => (round ? [{ roundId: round.roundId, kind: round.kind }] : []))];
  return { baseCashTokens: config.base_cash_tokens, exitRoundIds: new Set(kinds.filter((round) => round.kind === "Exit" && roundIds.includes(round.roundId)).map((round) => round.roundId)) };
}

/** Reads the account's storage, the engine minimum and its rows, and returns what the change needs. */
export async function readStorageNeed(views: EngineViews, account: string, change: StorageChange, signal?: AbortSignal): Promise<StorageNeed | null> {
  const [storage, minimum, portfolio] = await Promise.all([views.storageBalanceOf(account, { signal }), views.storageMinimum({ signal }), views.getPortfolio(account, { signal })]);
  const context = await readStorageContext(views, portfolio, change, { signal });
  return storageNeed({ storage, minimum, portfolio, change, context });
}
