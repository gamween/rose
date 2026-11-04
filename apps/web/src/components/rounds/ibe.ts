/**
 * Browser-side sealing and opening (spec 5.1, 5.2) through `@rose/ibe-wasm`: the glue and the
 * wasm are downloaded once on first use (never with the page), orders are encrypted to the round identity derived from the engine
 * account and the round id, and bound to `(round_id, bidder, side)` as associated data.
 */

import type { OpenedOrder, OrderIdentity, SealedOrder } from "@rose/ibe-wasm";
import type { Side } from "@rose/sdk";

type IbeModule = typeof import("@rose/ibe-wasm");

let loading: Promise<IbeModule> | null = null;

/** Loads the glue and the wasm once; the glue resolves `rose_ibe_bg.wasm` next to itself through `import.meta.url`. */
function ensureIbe(): Promise<IbeModule> {
  loading ??= import("@rose/ibe-wasm")
    .then(async (ibe) => {
      await ibe.loadIbe();
      return ibe;
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

export function orderIdentity(mpk: string, engineAccount: string, roundId: bigint, bidder: string, side: Side): OrderIdentity {
  return { mpk, engineAccount, roundId, bidder, side };
}

export async function sealOrder(identity: OrderIdentity, quantity: bigint, limitPrice: bigint): Promise<SealedOrder> {
  const ibe = await ensureIbe();
  return ibe.encryptBid(identity, { quantity, limitPrice });
}

export async function openOrder(identity: OrderIdentity, roundKey: string, ciphertextHex: string): Promise<OpenedOrder> {
  const ibe = await ensureIbe();
  return ibe.decryptBid(identity, roundKey, ciphertextHex);
}

export async function checkRoundKey(mpk: string, engineAccount: string, roundId: bigint, roundKey: string): Promise<boolean> {
  const ibe = await ensureIbe();
  return ibe.verifyRoundKey(mpk, engineAccount, roundId, roundKey);
}

/** Unwraps a public CKD response `(big_y, big_c)` with the round's public scalar (the `submit_key` fallback). */
export async function unwrapKey(engineAccount: string, roundId: bigint, bigY: string, bigC: string): Promise<string> {
  const ibe = await ensureIbe();
  return ibe.unwrapRoundKey(engineAccount, roundId, bigY, bigC);
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
