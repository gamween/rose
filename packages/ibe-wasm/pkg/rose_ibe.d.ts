/* tslint:disable */
/* eslint-disable */

/**
 * Unwrap a CKD response `(big_y, big_c)` for a round with its public app scalar.
 * Returns the round key as `bls12381g1:<base58>`; check it with [`verify_key`].
 */
export function ckd_unwrap(engine_account: string, round_id: bigint, big_y: string, big_c: string): string;

/**
 * Decrypt a sealed order with the released round key (verified against `mpk` first).
 * Returns `{ quantity, limit_price, salt, sigma }`; `(plaintext, sigma)` is the opening the
 * engine verifies.
 */
export function decrypt_bid(mpk: string, engine_account: string, round_id: bigint, key: string, ciphertext: Uint8Array | number[], bidder: string, side: number): any;

/**
 * Hex of the round identity `app_id` (for display and cross-checks).
 */
export function derive_app_id_hex(engine_account: string, round_id: bigint): string;

/**
 * Seal an order for `(round_id, bidder, side)` under the CKD master public key `mpk`.
 * Returns `{ ciphertext: Uint8Array (192 bytes), salt: hex }`.
 */
export function encrypt_bid(mpk: string, engine_account: string, round_id: bigint, bidder: string, side: number, quantity: string, limit_price: string): any;

/**
 * Check a round key against the CKD master public key and the round identity.
 */
export function verify_key(mpk: string, engine_account: string, round_id: bigint, key: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly ckd_unwrap: (a: number, b: number, c: bigint, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly decrypt_bid: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly derive_app_id_hex: (a: number, b: number, c: bigint) => [number, number];
    readonly encrypt_bid: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly verify_key: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number) => [number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
