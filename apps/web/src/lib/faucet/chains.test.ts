import { afterEach, describe, expect, it, vi } from "vitest";
import { createFaucetSenders, DEFAULT_NEAR_FUNDER_YOCTO, FaucetError, nearAmountLabel, readFaucetConfig } from "./chains";

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
