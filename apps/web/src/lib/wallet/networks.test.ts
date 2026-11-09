import { describe, expect, it } from "vitest";
import { connectedWallets, missingNetworks, networkInfo, NETWORKS } from "./networks";

describe("networks", () => {
  it("offers NEAR first, as the only network required for trading", () => {
    expect(NETWORKS.map((network) => network.chain)).toEqual(["near", "base", "solana"]);
    expect(NETWORKS.filter((network) => network.requiredForTrading).map((network) => network.chain)).toEqual(["near"]);
    expect(networkInfo("solana").testnet).toBe("Devnet");
  });

  it("lists connected wallets in network order, NEAR first whatever was connected first", () => {
    expect(connectedWallets({ near: null, base: null, solana: null })).toEqual([]);
    expect(connectedWallets({ near: "rose-demo-1.testnet", base: "0xabc", solana: null })).toEqual([
      { chain: "near", address: "rose-demo-1.testnet" },
      { chain: "base", address: "0xabc" },
    ]);
    expect(connectedWallets({ near: null, base: null, solana: "So1" })[0]?.chain).toBe("solana");
  });

  it("offers the networks that are not connected yet", () => {
    const connected = connectedWallets({ near: "rose-demo-1.testnet", base: null, solana: "So1" });
    expect(missingNetworks(connected).map((network) => network.chain)).toEqual(["base"]);
    expect(missingNetworks([]).map((network) => network.chain)).toEqual(["near", "base", "solana"]);
  });
});
