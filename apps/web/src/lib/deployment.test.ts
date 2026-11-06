import { BASE_SEPOLIA_CHAIN_ID as SDK_BASE_SEPOLIA_CHAIN_ID } from "@rose/sdk";
import { describe, expect, it, vi } from "vitest";
import { NearRpc } from "@rose/sdk";
import { BASE_SEPOLIA_CHAIN_ID, DEPLOYMENT, deployed, deployedAddress, isDeployed, missingDeployments, NEAR_READ_RPC_ENDPOINTS, NEAR_TUSDC_ACCOUNT, SABLIER_LOCKUP_ADDRESS } from "./deployment";

describe("deployment config", () => {
  it("lists every deployable contract with its NEXT_PUBLIC variable", () => {
    expect(DEPLOYMENT.map((entry) => entry.env)).toEqual([
      "NEXT_PUBLIC_ENGINE_ACCOUNT",
      "NEXT_PUBLIC_ROSE_VAULT_ADDRESS",
      "NEXT_PUBLIC_BASE_TUSDC_ADDRESS",
      "NEXT_PUBLIC_DEMO_TOKEN_ADDRESS",
      "NEXT_PUBLIC_DEMO_STREAM_FAUCET_ADDRESS",
      "NEXT_PUBLIC_SOLANA_VAULT_ADDRESS",
      "NEXT_PUBLIC_SOLANA_GAS_PAYER_ADDRESS",
      "NEXT_PUBLIC_SOLANA_DEMO_MINT",
    ]);
    for (const entry of DEPLOYMENT) expect(["near", "base", "solana"]).toContain(entry.chain);
  });

  it("reports unset variables as not deployed (the test environment sets none)", () => {
    expect(deployed("roseVault")).toBeNull();
    expect(deployedAddress("roseVault")).toBeNull();
    expect(isDeployed("roseVault", "engineAccount")).toBe(false);
    expect(missingDeployments().map((entry) => entry.key)).toContain("roseVault");
  });

  it("reads NEAR through dRPC when FastNEAR and the official RPC both rate limit the visitor", async () => {
    expect(NEAR_READ_RPC_ENDPOINTS).toEqual(["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"]);
    const fetch = vi.fn((url: string | URL | Request) =>
      Promise.resolve(String(url).includes("drpc") ? new Response(JSON.stringify({ jsonrpc: "2.0", id: "rose", result: { header: { height: 7, hash: "h", timestamp: 0, timestamp_nanosec: "0" } } })) : new Response("Too Many Requests", { status: 429 })),
    );
    const rpc = new NearRpc({ endpoints: NEAR_READ_RPC_ENDPOINTS, fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(rpc.block("final")).resolves.toMatchObject({ header: { height: 7 } });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([...NEAR_READ_RPC_ENDPOINTS]);
  });

  it("exposes the fixed testnet addresses", () => {
    expect(NEAR_TUSDC_ACCOUNT).toBe("tusdc.rose-app.testnet");
    expect(SABLIER_LOCKUP_ADDRESS).toBe("0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e");
  });

  it("names Base Sepolia with the SDK's chain id", () => {
    expect(BASE_SEPOLIA_CHAIN_ID).toBe(SDK_BASE_SEPOLIA_CHAIN_ID);
  });
});
