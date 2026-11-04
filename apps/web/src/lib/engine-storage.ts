/**
 * The engine's NEP-145 storage, as the app needs it before a voluntary receipt (spec 4, Unit):
 * a NEAR cash deposit (`ft_transfer_call`) needs room for a cash row in the `Near` venue, an
 * Exit bid needs room for the holding row of the class it buys. The engine charges every row
 * at its measured size for the longest account id (`contracts/engine/src/storage.rs`): record
 * 137 bytes, holding row 310 bytes, cash row 172 bytes, at the protocol's 1e19 yoctoNEAR per
 * byte; `storage_balance_bounds().min` (619 bytes, 0.00619 NEAR) covers the record, one holding
 * row and one cash row.
 *
 * The engine exposes the deposit (`storage_balance_of.total`) but not the bytes in use, so the
 * bytes are rebuilt from the account's rows as `get_portfolio` lists them: a holding row exists
 * while its balance or stored claimable is non-zero, a cash row while its balance is non-zero.
 */

import { CASH_ROW_STORAGE_DEPOSIT, type EngineViews, type Portfolio, type StorageBalance, type Venue } from "@rose/sdk";
import { sameVenue } from "./amounts";

/** NEAR protocol storage price, yoctoNEAR per byte (`storage_amount_per_byte`). */
export const STORAGE_BYTE_COST = 10n ** 19n;
/** `STORAGE_ACCOUNT_BYTES` of the engine. */
export const STORAGE_RECORD_BYTES = 137n;
/** `HOLDING_ROW_BYTES` of the engine (the row and its entry in the account's class list). */
export const HOLDING_ROW_BYTES = 310n;
/** `CASH_ROW_BYTES` of the engine (`CASH_ROW_STORAGE_DEPOSIT` of the SDK, in bytes). */
export const CASH_ROW_BYTES = CASH_ROW_STORAGE_DEPOSIT / STORAGE_BYTE_COST;

/** What the account must attach to `storage_deposit` before the action, or null when its deposit already covers it. */
export type StorageNeed = { kind: "register" | "top_up"; deposit: bigint };

/** The rows an action adds: a cash row in `cashVenue`, a holding row of `classId` (each only when the account has none yet). */
export type StorageChange = { cashVenue?: Venue; classId?: string };

/** Rows of the account that the engine charges, rebuilt from its portfolio. */
export function chargedBytes(portfolio: Pick<Portfolio, "holdings" | "cash">): bigint {
  const holdings = portfolio.holdings.filter((holding) => holding.balance > 0n || holding.claimable > 0n).length;
  const cash = portfolio.cash.filter((entry) => entry.amount > 0n).length;
  return STORAGE_RECORD_BYTES + BigInt(holdings) * HOLDING_ROW_BYTES + BigInt(cash) * CASH_ROW_BYTES;
}

/** Bytes the change adds to the account's rows. */
export function addedBytes(portfolio: Pick<Portfolio, "holdings" | "cash">, change: StorageChange): bigint {
  let bytes = 0n;
  if (change.cashVenue !== undefined) {
    const venue = change.cashVenue;
    const row = portfolio.cash.find((entry) => sameVenue(entry.venue, venue));
    if (!row || row.amount === 0n) bytes += CASH_ROW_BYTES;
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
export function storageNeed(input: { storage: StorageBalance | null; minimum: bigint; portfolio: Pick<Portfolio, "holdings" | "cash">; change: StorageChange }): StorageNeed | null {
  const { storage, minimum, portfolio, change } = input;
  const added = addedBytes(portfolio, change);
  if (storage === null) {
    const required = (STORAGE_RECORD_BYTES + added) * STORAGE_BYTE_COST;
    return { kind: "register", deposit: required > minimum ? required : minimum };
  }
  const required = (chargedBytes(portfolio) + added) * STORAGE_BYTE_COST;
  return required > storage.total ? { kind: "top_up", deposit: required - storage.total } : null;
}

/** Reads the account's storage, the engine minimum and its rows, and returns what the change needs. */
export async function readStorageNeed(views: EngineViews, account: string, change: StorageChange, signal?: AbortSignal): Promise<StorageNeed | null> {
  const [storage, minimum, portfolio] = await Promise.all([views.storageBalanceOf(account, { signal }), views.storageMinimum({ signal }), views.getPortfolio(account, { signal })]);
  return storageNeed({ storage, minimum, portfolio, change });
}
