/**
 * The plaintext of the orders this browser sealed, kept in `localStorage` so the bidder sees
 * what they bid while the book is sealed (the chain only holds the ciphertext), plus the
 * transaction hashes of the actions taken here (settlement links, spec 8.3). Keyed by engine,
 * round, account and side; nothing leaves the browser.
 */

import type { Side } from "@rose/sdk";

export interface LocalOrder {
  side: Side;
  quantity: string;
  limitPrice: string;
  salt: string;
  ciphertextHex: string;
  placedAt: number;
  bidId: number | null;
  txHash: string | null;
}

export type ReceiptKind = "place" | "close" | "open" | "clear" | "settle" | "cancel" | "cash";

export interface Receipt {
  kind: ReceiptKind;
  chain: "near" | "base";
  hash: string;
  at: number;
  label: string;
}

const PREFIX = "rose.rounds";
const CHANGE_EVENT = "rose:rounds-storage";

function notify(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** `useSyncExternalStore` subscription: fires after every write made by this module. */
export function subscribeLocal(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

/** Raw stored JSON (or "null"), stable between writes so it can serve as a store snapshot. */
export function rawSnapshot(key: string): string {
  const store = storage();
  if (!store) return "null";
  try {
    return store.getItem(key) ?? "null";
  } catch {
    return "null";
  }
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read<T>(key: string): T | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows: the plaintext then lives for the session only.
  }
  notify();
}

export function orderKey(engine: string, roundId: bigint, account: string, side: Side): string {
  return `${PREFIX}.order.${engine}.${roundId.toString()}.${account}.${side}`;
}

export function saveLocalOrder(engine: string, roundId: bigint, account: string, order: Omit<LocalOrder, "placedAt">): void {
  write(orderKey(engine, roundId, account, order.side), { ...order, placedAt: Date.now() });
}

export function receiptsKey(engine: string, roundId: bigint): string {
  return `${PREFIX}.receipts.${engine}.${roundId.toString()}`;
}

export function loadReceipts(engine: string, roundId: bigint): Receipt[] {
  const stored = read<Receipt[]>(receiptsKey(engine, roundId));
  return Array.isArray(stored) ? stored : [];
}

export function addReceipt(engine: string, roundId: bigint, receipt: Receipt): Receipt[] {
  const next = [...loadReceipts(engine, roundId).filter((r) => r.hash !== receipt.hash), receipt].slice(-200);
  write(receiptsKey(engine, roundId), next);
  return next;
}
