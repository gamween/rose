/**
 * NEP-145 storage the engine requires before an Exit bid: `place_bid` refuses a buyer whose
 * deposit has no room for the holding row the bought units will land in ("Insufficient storage
 * deposit for <account>: top up with storage_deposit"), so the engine never pays that row at
 * settlement.
 */

import type { Holding, StorageBalance } from "@rose/sdk";

/** The engine's `HOLDING_ROW_BYTES` (the row and its entry in the account's class list) at 1e19 yoctoNEAR per byte. */
export const HOLDING_ROW_STORAGE_DEPOSIT = 310n * 10_000_000_000_000_000_000n;

/**
 * The deposit to attach with `storage_deposit` before an Exit bid, in yoctoNEAR: the registration
 * minimum for an unregistered buyer, nothing when the buyer already has a row in the class, and
 * otherwise what `available` lacks for one holding row. The engine checks `cost(used + row) <=
 * deposit` and reports `available = deposit - max(cost(used), minimum)`, so topping up to
 * `row - available` always covers the check (it only over-deposits, withdrawably, while the
 * account uses less than the minimum).
 */
export function bidStorageTopUp(storage: StorageBalance | null, minimum: bigint, holding: Holding | null): bigint {
  if (storage === null) return minimum;
  const holdsRow = holding !== null && (holding.balance > 0n || holding.claimable > 0n || holding.lockedInRounds > 0n || holding.encumbered > 0n);
  if (holdsRow) return 0n;
  return storage.available >= HOLDING_ROW_STORAGE_DEPOSIT ? 0n : HOLDING_ROW_STORAGE_DEPOSIT - storage.available;
}
