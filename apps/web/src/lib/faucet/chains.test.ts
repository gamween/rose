import { afterEach, describe, expect, it, vi } from "vitest";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { createFaucetSenders, DEFAULT_NEAR_FUNDER_YOCTO, DEFAULT_SOLANA_DEMO_TOKENS, FaucetError, nearAmountLabel, readFaucetConfig, sendDemoTokens } from "./chains";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

const NEAR_KEY = "ed25519:8bWAWmjS8VxkwUiGJKyjEFZesSxchRZQ1YF5K6Xq8vu9";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NEAR faucet configuration", () => {
  it("keeps the funder fallback off unless both the account and its key are set", () => {
    expect(readFaucetConfig(env({ NEAR_FAUCET_ACCOUNT_ID: "rose-faucet.testnet" })).near.funderAccountId).toBeNull();
    const config = readFaucetConfig(env({ NEAR_FAUCET_ACCOUNT_ID: " rose-faucet.testnet ", NEAR_FAUCET_PRIVATE_KEY: "ed25519:x" }));
    expect(config.near.funderAccountId).toBe("rose-faucet.testnet");
    expect(config.near.funderYocto).toBe(DEFAULT_NEAR_FUNDER_YOCTO);
    expect(readFaucetConfig(env({ NEAR_FAUCET_YOCTO: "1000000000000000000000000" })).near.funderYocto).toBe(10n ** 24n);
  });

  it("labels yoctoNEAR amounts", () => {
    expect(nearAmountLabel(DEFAULT_NEAR_FUNDER_YOCTO)).toBe("1 NEAR");
    expect(nearAmountLabel(500_000_000_000_000_000_000_000n)).toBe("0.5 NEAR");
    expect(nearAmountLabel(10n ** 24n)).toBe("1 NEAR");
    expect(nearAmountLabel(1_250_000_000_000_000_000_000_000n)).toBe("1.25 NEAR");
  });
});

describe("Solana demo tokens", () => {
  const mint = Keypair.generate().publicKey;
  const payer = Keypair.generate();

  function connection(treasury: bigint, lamports: number): Connection {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: Keypair.generate().publicKey, supply: 10n ** 15n, decimals: 9, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
    return {
      getAccountInfo: () => Promise.resolve({ data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false }),
      getTokenAccountBalance: () => (treasury < 0n ? Promise.reject(new Error("could not find account")) : Promise.resolve({ value: { amount: treasury.toString() } })),
      getBalance: () => Promise.resolve(lamports),
    } as unknown as Connection;
  }

  it("is configured only with the hot wallet key and the demo mint, 1,000 tokens by default", () => {
    expect(readFaucetConfig(env({ SOLANA_FAUCET_SECRET_KEY: "k" }))["solana-demo-token"].configured).toBe(false);
    const config = readFaucetConfig(env({ SOLANA_FAUCET_SECRET_KEY: "k", NEXT_PUBLIC_SOLANA_DEMO_MINT: " 2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv " }))["solana-demo-token"];
    expect(config).toMatchObject({ configured: true, mint: "2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv", wholeTokens: DEFAULT_SOLANA_DEMO_TOKENS });
    expect(DEFAULT_SOLANA_DEMO_TOKENS).toBe(1_000n);
  });

  it("refuses a program-derived address and reports an empty treasury or an empty SOL balance as dry", async () => {
    const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], TOKEN_PROGRAM_ID)[0];
    await expect(sendDemoTokens(connection(10n ** 13n, 10 ** 9), payer, mint, pda, 1_000n)).rejects.toMatchObject({ code: "invalid_request" });
    const wallet = Keypair.generate().publicKey;
    await expect(sendDemoTokens(connection(999n * 10n ** 9n, 10 ** 9), payer, mint, wallet, 1_000n)).rejects.toMatchObject({ code: "faucet_dry", message: expect.stringContaining("demo token treasury") });
    await expect(sendDemoTokens(connection(-1n, 10 ** 9), payer, mint, wallet, 1_000n)).rejects.toMatchObject({ code: "faucet_dry" });
    await expect(sendDemoTokens(connection(10n ** 13n, 1_000_000), payer, mint, wallet, 1_000n)).rejects.toMatchObject({ code: "faucet_dry", message: expect.stringContaining("faucet wallet is empty") });
  });
});

describe("NEAR account creation through the helper", () => {
  it("returns the helper's transaction and its 10 NEAR funding", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ transaction: { hash: "Hx" }, status: { SuccessValue: "" } }), { status: 200 })));
    const senders = createFaucetSenders(env({}));
    await expect(senders.createNearAccount("alice-demo.testnet", NEAR_KEY)).resolves.toEqual({ txHash: "Hx", amount: "10 NEAR" });
  });

  it("surfaces a rate-limited helper when no funder account is configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Rate limit exceeded, retry in 7 hours.", { status: 429 })));
    const senders = createFaucetSenders(env({}));
    const error = await senders.createNearAccount("alice-demo.testnet", NEAR_KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FaucetError);
    expect((error as FaucetError).code).toBe("upstream");
    expect((error as FaucetError).message).toBe("The NEAR faucet helper answered HTTP 429: Rate limit exceeded, retry in 7 hours..");
  });

  it("never falls back on a request the helper refused as invalid", async () => {
    const fetchMock = vi.fn(async () => new Response("account id is invalid", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const senders = createFaucetSenders(env({ NEAR_FAUCET_ACCOUNT_ID: "rose-faucet.testnet", NEAR_FAUCET_PRIVATE_KEY: NEAR_KEY }));
    const error = await senders.createNearAccount("bad.testnet", NEAR_KEY).catch((e: unknown) => e);
    expect((error as FaucetError).code).toBe("invalid_request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
