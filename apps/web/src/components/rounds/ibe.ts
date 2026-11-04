/**
 * Browser-side sealing and opening (spec 5.1, 5.2) through `@rose/ibe-wasm`: the module is
 * loaded once on first use, orders are encrypted to the round identity derived from the engine
 * account and the round id, and bound to `(round_id, bidder, side)` as associated data.
 */

import { decryptBid, encryptBid, loadIbe, verifyRoundKey, type OpenedOrder, type OrderIdentity, type SealedOrder } from "@rose/ibe-wasm";
import type { Side } from "@rose/sdk";

let loading: Promise<void> | null = null;

/** Loads the wasm once; the glue resolves `rose_ibe_bg.wasm` next to itself through `import.meta.url`. */
export function ensureIbe(): Promise<void> {
  loading ??= loadIbe().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export function orderIdentity(mpk: string, engineAccount: string, roundId: bigint, bidder: string, side: Side): OrderIdentity {
  return { mpk, engineAccount, roundId, bidder, side };
}

export async function sealOrder(identity: OrderIdentity, quantity: bigint, limitPrice: bigint): Promise<SealedOrder> {
  await ensureIbe();
  return encryptBid(identity, { quantity, limitPrice });
}

export async function openOrder(identity: OrderIdentity, roundKey: string, ciphertextHex: string): Promise<OpenedOrder> {
  await ensureIbe();
  return decryptBid(identity, roundKey, ciphertextHex);
}

export async function checkRoundKey(mpk: string, engineAccount: string, roundId: bigint, roundKey: string): Promise<boolean> {
  await ensureIbe();
  return verifyRoundKey(mpk, engineAccount, roundId, roundKey);
}

/** SHA-256 of a ciphertext, shown in the sealed book next to the public collateral. */
export async function ciphertextHash(ciphertextHex: string): Promise<string> {
  const bytes = new Uint8Array(ciphertextHex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(ciphertextHex.slice(i * 2, i * 2 + 2), 16);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}
