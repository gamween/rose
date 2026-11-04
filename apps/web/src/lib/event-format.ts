/**
 * Human amounts for the engine's event lines (activity feed, portfolio history): cash in USDC
 * (6 decimals in every venue), units with their class's decimals, raw only while a class is
 * unknown to the caller.
 */

import type { EventAmountFormat } from "@rose/sdk";
import { formatUnits } from "@/lib/format";

const USDC_DECIMALS = 6;

function toBigInt(amount: string): bigint | null {
  return /^\d+$/.test(amount) ? BigInt(amount) : null;
}

export function eventAmountFormat(decimalsOf: (classId: string) => number | null): EventAmountFormat {
  return {
    cash: (amount) => {
      const value = toBigInt(amount);
      return value === null ? amount : `${formatUnits(value, USDC_DECIMALS, 2)} USDC`;
    },
    units: (amount, classId) => {
      const value = toBigInt(amount);
      const decimals = decimalsOf(classId);
      return value === null || decimals === null ? amount : formatUnits(value, decimals, 4);
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
