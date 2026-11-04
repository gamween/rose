import { describe, expect, it } from "vitest";
import { isValidNearEd25519Key, isValidNearTestnetAccountId, isValidSolanaAddress, parseFaucetRequest, requestSubject } from "./validate";

const NEAR_KEY = "ed25519:8bWAWmjS8VxkwUiGJKyjEFZesSxchRZQ1YF5K6Xq8vu9";
const SOL_ADDRESS = "6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n";
const EVM_ADDRESS = "0x7d4777cfC6ed48061B0BcCae558D29919b412042";

describe("NEAR account ids", () => {
  it("accepts lowercase top-level testnet ids", () => {
    expect(isValidNearTestnetAccountId("alice-demo.testnet")).toBe(true);
    expect(isValidNearTestnetAccountId("rose_1.testnet")).toBe(true);
  });
  it("refuses uppercase, sub-accounts, bare labels, bad separators and long ids", () => {
    expect(isValidNearTestnetAccountId("Alice.testnet")).toBe(false);
    expect(isValidNearTestnetAccountId("a.b.testnet")).toBe(false);
    expect(isValidNearTestnetAccountId("alice")).toBe(false);
    expect(isValidNearTestnetAccountId(".testnet")).toBe(false);
    expect(isValidNearTestnetAccountId("-alice.testnet")).toBe(false);
    expect(isValidNearTestnetAccountId("al--ice.testnet")).toBe(false);
    expect(isValidNearTestnetAccountId(`${"a".repeat(57)}.testnet`)).toBe(false);
    expect(isValidNearTestnetAccountId("alice.near")).toBe(false);
  });
});

describe("keys and addresses", () => {
  it("validates ed25519 NEAR keys by decoded length", () => {
    expect(isValidNearEd25519Key(NEAR_KEY)).toBe(true);
    expect(isValidNearEd25519Key("ed25519:abc")).toBe(false);
    expect(isValidNearEd25519Key("secp256k1:8bWAWmjS8VxkwUiGJKyjEFZesSxchRZQ1YF5K6Xq8vu9")).toBe(false);
    expect(isValidNearEd25519Key("ed25519:0OIl")).toBe(false);
  });
  it("validates Solana public keys", () => {
    expect(isValidSolanaAddress(SOL_ADDRESS)).toBe(true);
    expect(isValidSolanaAddress("not-a-key")).toBe(false);
    expect(isValidSolanaAddress(EVM_ADDRESS)).toBe(false);
  });
});

describe("parseFaucetRequest", () => {
  it("parses each chain and trims fields", () => {
    expect(parseFaucetRequest({ chain: "base", address: ` ${EVM_ADDRESS} ` })).toEqual({ ok: true, request: { chain: "base", address: EVM_ADDRESS } });
    expect(parseFaucetRequest({ chain: "solana", address: SOL_ADDRESS })).toEqual({ ok: true, request: { chain: "solana", address: SOL_ADDRESS } });
    expect(parseFaucetRequest({ chain: "near", accountId: "alice-demo.testnet", publicKey: NEAR_KEY })).toEqual({
      ok: true,
      request: { chain: "near", accountId: "alice-demo.testnet", publicKey: NEAR_KEY },
    });
  });
  it("rejects malformed bodies with readable messages", () => {
    expect(parseFaucetRequest(null)).toMatchObject({ ok: false, message: expect.stringContaining("JSON object") });
    expect(parseFaucetRequest({ chain: "bitcoin", address: "x" })).toMatchObject({ ok: false, message: expect.stringContaining("chain must be") });
    expect(parseFaucetRequest({ chain: "base", address: "0x123" })).toMatchObject({ ok: false, message: expect.stringContaining("Ethereum address") });
    expect(parseFaucetRequest({ chain: "solana", address: EVM_ADDRESS })).toMatchObject({ ok: false, message: expect.stringContaining("Solana") });
    expect(parseFaucetRequest({ chain: "near", accountId: "Alice.testnet", publicKey: NEAR_KEY })).toMatchObject({ ok: false, message: expect.stringContaining("accountId") });
    expect(parseFaucetRequest({ chain: "near", accountId: "alice.testnet", publicKey: "ed25519:xx" })).toMatchObject({ ok: false, message: expect.stringContaining("publicKey") });
    expect(parseFaucetRequest({ chain: "near", address: SOL_ADDRESS })).toMatchObject({ ok: false });
  });
  it("rate limits on the lowercase address or the account id", () => {
    expect(requestSubject({ chain: "base", address: EVM_ADDRESS })).toBe(EVM_ADDRESS.toLowerCase());
    expect(requestSubject({ chain: "near", accountId: "alice.testnet", publicKey: NEAR_KEY })).toBe("alice.testnet");
  });
});
