import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_WHOLE_TOKENS, demoPositionLinks, demoStreamAmounts, requestDemoTokens } from "./solana-stream";

afterEach(() => vi.unstubAllGlobals());

describe("demo Streamflow position", () => {
  it("locks 1,000 whole tokens of the mint's decimals (CINDR has 9), 10 % at the cliff, the rest hourly over 23 days", () => {
    expect(DEMO_WHOLE_TOKENS).toBe(1_000n);
    expect(demoStreamAmounts(9)).toEqual({ amount: 1_000_000_000_000n, cliffAmount: 100_000_000_000n, amountPerPeriod: 1_630_434_782n });
    expect(demoStreamAmounts(6).amount).toBe(1_000_000_000n);
  });

  it("links the faucet transfer and the stream creation under distinct labels", () => {
    expect(demoPositionLinks({ txId: "create", metadataId: "m", faucetTx: "tokens" })).toEqual([
      { href: "https://explorer.solana.com/tx/tokens?cluster=devnet", label: "Demo tokens from the faucet" },
      { href: "https://explorer.solana.com/tx/create?cluster=devnet", label: "Stream creation on Solana Explorer" },
    ]);
    expect(demoPositionLinks({ txId: "create", metadataId: "m", faucetTx: null })).toHaveLength(1);
  });

  it("asks the faucet's solana-demo-token action for the tokens and explains its refusals", async () => {
    const owner = Keypair.generate().publicKey;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ chain: "solana-demo-token", signature: "3tok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestDemoTokens(owner)).resolves.toBe("3tok");
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ chain: "solana-demo-token", address: owner.toBase58() });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "rate_limited", message: "This solana-demo-token faucet was already used by this address in the last 24 hours." }), { status: 429 })));
    await expect(requestDemoTokens(owner)).rejects.toMatchObject({ kind: "rate_limited", title: "Demo tokens already sent", retryable: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "faucet_dry", message: "The demo token treasury of the Solana faucet is empty; ask the team to refill it." }), { status: 409 })));
    await expect(requestDemoTokens(owner)).rejects.toMatchObject({ kind: "insufficient_balance", message: expect.stringContaining("treasury") });
  });
});
