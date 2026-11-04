/**
 * Round trip against the live round-1 vectors of `contracts/ibe/tests/testnet_vectors.rs`
 * (recorded on NEAR testnet on 2026-11-04 against `v1.signer-prod.testnet` 3.18.0).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptBid, encryptBid, fromHex, loadIbeSync, plaintextHex, roundAppIdHex, toHex, unwrapRoundKey, verifyRoundKey } from "../src/index.js";

const MPK =
  "bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj";
const ENGINE = "rose-ckd-1793753433.testnet";
const ROUND1_APP_ID = "305bd2a108c0772db82c2d803d5eea87ba669442b9abcf6bd45b28b8926aa8f5";
const ROUND1_BIG_Y = "bls12381g1:6JsKyncUXqmVX4RcTD83LCcSL25iVYoi1ShPZxFE2hBoo27Lh2nXDNHu3JnA3Paara";
const ROUND1_BIG_C = "bls12381g1:5jQ5mhW68mDqLQGxgnDiFShQy87sFxrDrQ1QLoYibyyZWDUsaJ19nVCaYr38FnqBbF";
const ROUND1_KEY = "bls12381g1:6znYwWzn6SVgzXFKy7zEmZA6CR2aS317nJXuWKAmmeEdnrc3Qp6dX7EfE26GZBA889";
const ROUND3_KEY = "bls12381g1:7KUB3YJyD2SdDtLWzNsnPEiWRtSigsAZVoVXLjnj9HHKic9TP1AbWjqoshCMk1HhGL";

const identity = { mpk: MPK, engineAccount: ENGINE, roundId: 1n, bidder: "b1.rose-ckd-1793753433.testnet", side: "Buy" as const };

beforeAll(() => {
  loadIbeSync(readFileSync(resolve(import.meta.dirname, "../pkg/rose_ibe_bg.wasm")));
});

describe("ibe wasm wrapper", () => {
  it("derives the live round identity and unwraps the live CKD response", () => {
    expect(roundAppIdHex(ENGINE, 1n)).toBe(ROUND1_APP_ID);
    expect(unwrapRoundKey(ENGINE, 1n, ROUND1_BIG_Y, ROUND1_BIG_C)).toBe(ROUND1_KEY);
    expect(verifyRoundKey(MPK, ENGINE, 1n, ROUND1_KEY)).toBe(true);
    expect(verifyRoundKey(MPK, ENGINE, 1n, ROUND3_KEY)).toBe(false);
  });

  it("seals an order to 192 bytes and opens it with the round key", () => {
    const sealed = encryptBid(identity, { quantity: 123_456_789_012_345_678_901n, limitPrice: 9_000_000n });
    expect(sealed.ciphertext).toHaveLength(192);
    expect(sealed.ciphertextHex).toBe(toHex(sealed.ciphertext));
    expect(sealed.salt).toMatch(/^[0-9a-f]{32}$/);
    const opened = decryptBid(identity, ROUND1_KEY, sealed.ciphertextHex);
    expect(opened.quantity).toBe(123_456_789_012_345_678_901n);
    expect(opened.limitPrice).toBe(9_000_000n);
    expect(opened.salt).toBe(sealed.salt);
    expect(opened.sigma).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.plaintextHex).toBe(plaintextHex(opened.quantity, opened.limitPrice, opened.salt));
    expect(fromHex(opened.plaintextHex)).toHaveLength(48);
  });

  it("encodes the plaintext as little-endian u128 pairs followed by the salt", () => {
    const hex = plaintextHex(1n, 256n, "0a".repeat(16));
    expect(hex).toBe(`${"01".padEnd(32, "0")}${"0001".padEnd(32, "0")}${"0a".repeat(16)}`);
  });

  it("refuses to open a ciphertext under another bidder or side", () => {
    const sealed = encryptBid(identity, { quantity: 1n, limitPrice: 1n });
    expect(() => decryptBid({ ...identity, bidder: "b2.rose-ckd-1793753433.testnet" }, ROUND1_KEY, sealed.ciphertext)).toThrow();
    expect(() => decryptBid({ ...identity, side: "Sell" }, ROUND1_KEY, sealed.ciphertext)).toThrow();
    expect(() => decryptBid(identity, ROUND3_KEY, sealed.ciphertext)).toThrow();
  });
});
