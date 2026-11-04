/**
 * Sealed orders with the browser's own IBE build (`@rose/ibe-wasm`, the rose-ibe crate compiled
 * to wasm) under Node: encryption to the round identity with the live CKD master key, decryption
 * with the released round key, and the deliberately malformed ciphertext of the demo.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decryptBid, encryptBid, fromHex, loadIbeSync, toHex, unwrapRoundKey, type IbeSide, type OpenedOrder, type SealedOrder } from "@rose/ibe-wasm";

loadIbeSync(readFileSync(fileURLToPath(import.meta.resolve("@rose/ibe-wasm/rose_ibe_bg.wasm"))));

/** Offset of `V` in a ciphertext: `U (96) || V (32) || W (64)`. */
const V_OFFSET = 96;

export interface Identity {
  mpk: string;
  engine: string;
  roundId: bigint;
  bidder: string;
  side: IbeSide;
}

export function seal(identity: Identity, quantity: bigint, limitPrice: bigint): SealedOrder {
  return encryptBid({ mpk: identity.mpk, engineAccount: identity.engine, roundId: identity.roundId, bidder: identity.bidder, side: identity.side }, { quantity, limitPrice });
}

export function open(identity: Identity, roundKey: string, ciphertextHex: string): OpenedOrder {
  return decryptBid({ mpk: identity.mpk, engineAccount: identity.engine, roundId: identity.roundId, bidder: identity.bidder, side: identity.side }, roundKey, ciphertextHex);
}

/**
 * A ciphertext with an inconsistent `V`: the first byte of `V` flipped. Nobody can open it, its
 * author included: decryption yields a sigma whose re-encryption does not give `U`, and the
 * author's true `(plaintext, sigma)` fails the engine's `V` check.
 */
export function corrupt(ciphertextHex: string): string {
  const bytes = fromHex(ciphertextHex);
  bytes[V_OFFSET] = (bytes[V_OFFSET] ?? 0) ^ 0x01;
  return toHex(bytes);
}

export function unwrap(engine: string, roundId: bigint, bigY: string, bigC: string): string {
  return unwrapRoundKey(engine, roundId, bigY, bigC);
}
