/**
 * `@rose/ibe-wasm`: the rose-ibe crate (`contracts/ibe`) compiled with wasm-bindgen, wrapped in
 * typed `encryptBid` / `decryptBid` helpers. Build with `pnpm -C packages/ibe-wasm build:wasm`
 * (the exact commands are in `build-wasm.sh`); the generated `pkg/` is committed so the web app
 * builds without a Rust toolchain.
 *
 * @module
 */

import init, { ckd_unwrap, decrypt_bid, derive_app_id_hex, encrypt_bid, initSync, verify_key } from "../pkg/rose_ibe.js";

export type IbeSide = "Buy" | "Sell";

/** Everything that identifies a sealed order's recipient identity and associated data. */
export interface OrderIdentity {
  /** CKD master public key of the engine's domain (`get_config().ckd_public_key`, `bls12381g2:<b58>`). */
  mpk: string;
  /** Engine account id (the CKD predecessor). */
  engineAccount: string;
  roundId: bigint;
  bidder: string;
  side: IbeSide;
}

export interface SealedOrder {
  /** 192 bytes: `U (96) || V (32) || W (64)`. */
  ciphertext: Uint8Array;
  /** `ciphertext` as lowercase hex, the `ciphertext_hex` argument of `place_bid` / `place_ask`. */
  ciphertextHex: string;
  /** 16 random bytes as hex; keep it with the order to rebuild the opening later. */
  salt: string;
}

export interface OpenedOrder {
  quantity: bigint;
  limitPrice: bigint;
  salt: string;
  /** 32 bytes as hex, the `sigma_hex` argument of `open_bid`. */
  sigma: string;
  /** 48 bytes as hex (`quantity u128 LE || limit_price u128 LE || salt`), the `plaintext_hex` argument of `open_bid`. */
  plaintextHex: string;
}

export type WasmSource = Parameters<typeof init>[0];

let ready: Promise<void> | null = null;

/**
 * Loads the wasm module once. In the browser the default resolves `rose_ibe_bg.wasm` next to the
 * glue through `import.meta.url`; pass a URL or bytes to load it from elsewhere (for example the
 * copy the web app serves from `/ibe/rose_ibe_bg.wasm`).
 */
export function loadIbe(source?: WasmSource): Promise<void> {
  ready ??= init(source === undefined ? undefined : { module_or_path: source }).then(() => undefined);
  return ready;
}

/** Synchronous loader for tests and workers that already hold the wasm bytes. */
export function loadIbeSync(bytes: BufferSource | WebAssembly.Module): void {
  initSync({ module: bytes });
  ready = Promise.resolve();
}

function assertLoaded(): void {
  if (ready === null) throw new Error("Call loadIbe() before using the IBE functions.");
}

export function sideByte(side: IbeSide): number {
  return side === "Buy" ? 0 : 1;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error("Invalid hex string.");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function u128ToLeHex(value: bigint): string {
  if (value < 0n || value > (1n << 128n) - 1n) throw new Error("Amount does not fit in u128.");
  let hex = "";
  let rest = value;
  for (let i = 0; i < 16; i += 1) {
    hex += Number(rest & 0xffn)
      .toString(16)
      .padStart(2, "0");
    rest >>= 8n;
  }
  return hex;
}

/** Rebuilds the 48-byte plaintext the engine verifies from an opened order. */
export function plaintextHex(quantity: bigint, limitPrice: bigint, saltHex: string): string {
  if (fromHex(saltHex).length !== 16) throw new Error("The salt must be 16 bytes.");
  return `${u128ToLeHex(quantity)}${u128ToLeHex(limitPrice)}${saltHex.toLowerCase()}`;
}

/** Seals an order to the round identity; the engine stores the ciphertext and nobody can read it before the key is released. */
export function encryptBid(identity: OrderIdentity, order: { quantity: bigint; limitPrice: bigint }): SealedOrder {
  assertLoaded();
  const result = encrypt_bid(
    identity.mpk,
    identity.engineAccount,
    identity.roundId,
    identity.bidder,
    sideByte(identity.side),
    order.quantity.toString(),
    order.limitPrice.toString(),
  ) as { ciphertext: Uint8Array; salt: string };
  return { ciphertext: result.ciphertext, ciphertextHex: toHex(result.ciphertext), salt: result.salt };
}

/** Opens a sealed order with the released round key (checked against `mpk` first). */
export function decryptBid(identity: OrderIdentity, roundKey: string, ciphertext: Uint8Array | string): OpenedOrder {
  assertLoaded();
  const bytes = typeof ciphertext === "string" ? fromHex(ciphertext) : ciphertext;
  const result = decrypt_bid(identity.mpk, identity.engineAccount, identity.roundId, roundKey, bytes, identity.bidder, sideByte(identity.side)) as {
    quantity: string;
    limit_price: string;
    salt: string;
    sigma: string;
  };
  const quantity = BigInt(result.quantity);
  const limitPrice = BigInt(result.limit_price);
  return { quantity, limitPrice, salt: result.salt, sigma: result.sigma, plaintextHex: plaintextHex(quantity, limitPrice, result.salt) };
}

/** Whether `roundKey` is the private key of the round identity under `mpk`. */
export function verifyRoundKey(mpk: string, engineAccount: string, roundId: bigint, roundKey: string): boolean {
  assertLoaded();
  return verify_key(mpk, engineAccount, roundId, roundKey);
}

/** Unwraps a CKD response `(big_y, big_c)` into the round key (`bls12381g1:<b58>`); verify it afterwards. */
export function unwrapRoundKey(engineAccount: string, roundId: bigint, bigY: string, bigC: string): string {
  assertLoaded();
  return ckd_unwrap(engineAccount, roundId, bigY, bigC);
}

/** Hex of the round identity `app_id`, equal to `get_round().app_id`. */
export function roundAppIdHex(engineAccount: string, roundId: bigint): string {
  assertLoaded();
  return derive_app_id_hex(engineAccount, roundId);
}
