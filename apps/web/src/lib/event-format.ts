/**
 * Human amounts for the engine's event lines (activity feed, portfolio history, guided demo):
 * cash in USDC (6 decimals in every venue) with its significant decimals, so a clearing price of
 * 0.025 reads 0.025; units with their class's decimals, raw only while a class is unknown to the
 * caller; NEP-145 storage in NEAR.
 */

import type { EventAmountFormat } from "@rose/sdk";
import { formatCash, formatNearAmount, formatUnits } from "@/lib/format";

function toBigInt(amount: string): bigint | null {
  return /^\d+$/.test(amount) ? BigInt(amount) : null;
}

export function eventAmountFormat(decimalsOf: (classId: string) => number | null): EventAmountFormat {
  return {
    cash: (amount) => {
      const value = toBigInt(amount);
      return value === null ? amount : `${formatCash(value)} USDC`;
    },
    units: (amount, classId) => {
      const value = toBigInt(amount);
      const decimals = decimalsOf(classId);
      return value === null || decimals === null ? amount : formatUnits(value, decimals, 4);
    },
    near: (amount) => {
      const value = toBigInt(amount);
      return value === null ? amount : `${formatNearAmount(value)} NEAR`;
    },
  };
}

/** The class ids an event line mentions (`data.class_id`), to look their decimals up once. */
export function eventClassIds(events: readonly { event: { data: unknown } }[]): string[] {
  const ids = new Set<string>();
  for (const entry of events) {
    const classId = (entry.event.data as { class_id?: unknown }).class_id;
    if (typeof classId === "string") ids.add(classId);
  }
  return [...ids];
}
