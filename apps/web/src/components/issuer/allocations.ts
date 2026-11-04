/**
 * Cohort allocations and unit distributions: the `account,amount` lists the issuer types or
 * pastes, their validation against the unit schedule, and batching under the engine limit.
 */

import { isNearAccountId, parseAmount } from "@/lib/amounts";

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
 * Validates rows for `createStreams`: a NEAR account, a positive amount in whole-token text,
 * a multiple of `unitAmount` (base units) when one is given, no duplicate accounts.
 */
export function checkRows(rows: readonly AllocationRow[], decimals: number, unitAmount: bigint | null): CheckedRow[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const amountUnits = parseAmount(row.amount, decimals);
    let error: string | null = null;
    if (!isNearAccountId(row.account)) error = "Not a valid NEAR account id.";
    else if (seen.has(row.account)) error = "Duplicate account.";
    else if (amountUnits === null) error = `Not an amount (at most ${String(decimals)} decimals).`;
    else if (amountUnits <= 0n) error = "The amount must be positive.";
    else if (unitAmount !== null && unitAmount > 0n && amountUnits % unitAmount !== 0n) error = "Not a multiple of the unit amount.";
    seen.add(row.account);
    return { ...row, amountUnits, error };
  });
}

export function rowsTotal(rows: readonly CheckedRow[]): bigint {
  return rows.reduce((sum, row) => sum + (row.error === null && row.amountUnits !== null ? row.amountUnits : 0n), 0n);
}

/** Splits receivers into batches of at most `max` (the engine's `max_distribution_receivers`). */
export function splitBatches<T>(items: readonly T[], max: number): T[][] {
  const size = Math.max(1, max);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}
