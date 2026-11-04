import { describe, expect, it } from "vitest";
import { decodeAddress, decodeString, decodeUint, ethCall, solanaBalance, viewAccessKeyList } from "./rpc";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ABI decoding", () => {
  it("decodes the Sablier Lockup name as returned by eth_call", () => {
    const hex =
      "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001253" +
      "61626c696572204c6f636b7570204e46540000000000000000000000000000";
    expect(decodeString(hex)).toBe("Sablier Lockup NFT");
  });

  it("decodes addresses and integers", () => {
    expect(decodeAddress("0x000000000000000000000000a65a1ecef02c2b9bdc604951c6a6d02335d4532e")).toBe("0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e");
    expect(decodeUint("0x0000000000000000000000000000000000000000000000000000000000000006")).toBe(6n);
  });

  it("rejects truncated data", () => {
    expect(() => decodeUint("0x00")).toThrow(/too short/);
  });
});

describe("RPC helpers", () => {
  it("returns the raw access key list", async () => {
    const fetchImpl = async () => jsonResponse({ jsonrpc: "2.0", id: "rose", result: { block_hash: "h", block_height: 5, keys: [] } });
    await expect(viewAccessKeyList("engine.testnet", { fetchImpl })).resolves.toEqual({ block_hash: "h", block_height: 5, keys: [] });
  });

  it("reports a missing account by kind", async () => {
    const fetchImpl = async () =>
      jsonResponse({ jsonrpc: "2.0", id: "rose", error: { cause: { name: "UNKNOWN_ACCOUNT" }, data: "account nope.testnet does not exist" } });
    await expect(viewAccessKeyList("nope.testnet", { fetchImpl })).rejects.toMatchObject({ kind: "account_missing" });
  });

  it("surfaces eth_call reverts and Solana balances", async () => {
    const reverted = async () => jsonResponse({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } });
    await expect(ethCall("0x1", "0x582abd12", { fetchImpl: reverted })).rejects.toThrow(/execution reverted/);
    const balance = async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { context: { slot: 42, apiVersion: "x" }, value: 9647107580 } });
    await expect(solanaBalance("6uMy", { fetchImpl: balance })).resolves.toEqual({ lamports: 9647107580n, slot: 42 });
  });
});
