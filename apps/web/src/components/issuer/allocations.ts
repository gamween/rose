/**
 * Cohort allocations and unit distributions: the `account,amount` lists the issuer types or
 * pastes, their validation against the unit schedule, and batching under the engine limit.
 */

import { RECORD_STORAGE_DEPOSIT } from "@rose/sdk";
import { isNearAccountId, parseAmount } from "@/lib/amounts";

/** `RoseVault.MAX_ALLOCATIONS`: `createStreams` reverts `TooManyAllocations` above it. */
export const MAX_COHORT_ALLOCATIONS = 50;

export type AllocationRow = { account: string; amount: string };

export type CheckedRow = AllocationRow & { amountUnits: bigint | null; error: string | null };

/** Parses `account,amount` lines (comma, semicolon, tab or whitespace separated; blank lines and `#` comments skipped). */
export function parseAllocationLines(text: string): AllocationRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const [account = "", amount = ""] = line.split(/\s*[,;\t]\s*|\s+/).filter((part) => part.length > 0);
      return { account, amount };
    });
}

/**
 * Validates rows for `createStreams`: a NEAR account, a positive amount in whole-token text, at
 * least `minimum` base units when one is given (RoseVault refuses an allocation below one whole
 * token, `AmountBelowMinimum`), a multiple of `unitAmount` (base units) when one is given, no
 * duplicate accounts, and not `sender` when one is given (`distribute_units` panics "Cannot
 * transfer to self" when the issuer lists itself).
 */
export function checkRows(rows: readonly AllocationRow[], decimals: number, options: { unitAmount?: bigint | null; minimum?: bigint | null; sender?: string | null } = {}): CheckedRow[] {
  const { unitAmount = null, minimum = null, sender = null } = options;
  const seen = new Set<string>();
  return rows.map((row) => {
    const amountUnits = parseAmount(row.amount, decimals);
    let error: string | null = null;
    if (!isNearAccountId(row.account)) error = "Not a valid NEAR account id.";
    else if (sender !== null && row.account === sender) error = "This is your own account: the units are already yours (the engine refuses a transfer to self).";
    else if (seen.has(row.account)) error = "Duplicate account.";
    else if (amountUnits === null) error = `Not an amount (at most ${String(decimals)} decimals).`;
    else if (amountUnits <= 0n) error = "The amount must be positive.";
    else if (minimum !== null && amountUnits < minimum) error = "At least one whole token per holder (RoseVault minimum).";
    else if (unitAmount !== null && unitAmount > 0n && amountUnits % unitAmount !== 0n) error = "Not a multiple of the unit amount.";
    seen.add(row.account);
    return { ...row, amountUnits, error };
  });
}

export function rowsTotal(rows: readonly CheckedRow[]): bigint {
  return rows.reduce((sum, row) => sum + (row.error === null && row.amountUnits !== null ? row.amountUnits : 0n), 0n);
}

/** Why RoseVault would refuse the cohort as a whole, or null. */
export function cohortSizeError(count: number): string | null {
  return count > MAX_COHORT_ALLOCATIONS ? `RoseVault takes at most ${String(MAX_COHORT_ALLOCATIONS)} holders per createStreams; split the cohort (${String(count)} rows).` : null;
}

/**
 * What `distribute_units` needs attached for one receiver: `registration_deposit_for` minus the
 * deposit-record storage it includes (`RECORD_STORAGE_DEPOSIT`), which only a deposit
 * registration keeps. 0 means the receiver can already hold the units.
 */
export function distributionDeposit(registrationDeposit: bigint): bigint {
  return registrationDeposit > RECORD_STORAGE_DEPOSIT ? registrationDeposit - RECORD_STORAGE_DEPOSIT : 0n;
}

/** Splits receivers into batches of at most `max` (the engine's `max_distribution_receivers`). */
export function splitBatches<T>(items: readonly T[], max: number): T[][] {
  const size = Math.max(1, max);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}
