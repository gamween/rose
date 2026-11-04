import { describe, expect, it } from "vitest";
import { addressUrl, nearAccountUrl, nearBlockUrl, shortAddress, shorten, txLinks, txUrl } from "./explorer";

describe("explorer links", () => {
  it("builds the spec section 6 transaction links", () => {
    expect(txUrl("near", "66SvxXgw18sEvLMuNWDgFGqFcXJDDGXqutuNQFz6eUC4")).toBe("https://testnet.near.rocks/tx/66SvxXgw18sEvLMuNWDgFGqFcXJDDGXqutuNQFz6eUC4");
    expect(txUrl("base", "0xcddf41ac")).toBe("https://sepolia.basescan.org/tx/0xcddf41ac");
    expect(txUrl("solana", "4CrVjw75")).toBe("https://explorer.solana.com/tx/4CrVjw75?cluster=devnet");
  });

  it("gives NEAR toasts the primary explorer and the nearvalidate fallback", () => {
    const links = txLinks("near", "H");
    expect(links.map((link) => link.href)).toEqual(["https://testnet.near.rocks/tx/H", "https://nearvalidate.org/txns/H?network=testnet"]);
    expect(txLinks("base", "0x1")).toHaveLength(1);
  });

  it("links NEAR accounts and blocks to the near.rocks routes that render (account, not address)", () => {
    expect(nearAccountUrl("engine-s4.rose-app.testnet")).toBe("https://testnet.near.rocks/account/engine-s4.rose-app.testnet");
    expect(addressUrl("near", "alice.testnet")).toBe("https://testnet.near.rocks/account/alice.testnet");
    expect(nearBlockUrl(276_204_160)).toBe("https://testnet.near.rocks/block/276204160");
    expect(nearBlockUrl(276_204_160n)).toBe("https://testnet.near.rocks/block/276204160");
    expect(shorten("0x7d4777cfC6ed48061B0BcCae558D29919b412042")).toBe("0x7d47…2042");
    expect(shorten("short")).toBe("short");
  });

  it("links addresses and shortens them per chain", () => {
    expect(addressUrl("solana", "abc")).toBe("https://explorer.solana.com/address/abc?cluster=devnet");
    expect(shortAddress("base", "0x7d4777cfC6ed48061B0BcCae558D29919b412042")).toBe("0x7d47…2042");
    expect(shortAddress("near", "rose-app.testnet")).toBe("rose-app.testnet");
    expect(shortAddress("near", "a-very-long-demo-account-name.testnet")).toBe("a-very-lon…me.testnet");
  });
});
