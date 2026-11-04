import { describe, expect, it } from "vitest";
import { FaucetError, createFaucetHandler, type FaucetConfig, type FaucetSenders } from "@/lib/faucet";
import { MemoryRateLimiter, signCookie } from "@/lib/faucet/rate-limit";

const EVM_ADDRESS = "0x7d4777cfC6ed48061B0BcCae558D29919b412042";
const SOL_ADDRESS = "6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n";
const NEAR_KEY = "ed25519:8bWAWmjS8VxkwUiGJKyjEFZesSxchRZQ1YF5K6Xq8vu9";
const SECRET = "cookie-secret";
const T0 = 1_800_000_000_000;

function config(overrides: Partial<FaucetConfig> = {}): FaucetConfig {
  return {
    base: { configured: true, rpcUrl: "https://sepolia.base.org", amountWei: 2_000_000_000_000_000n },
    solana: { configured: true, rpcUrl: "https://api.devnet.solana.com", lamports: 50_000_000n },
    near: { configured: true, helperUrl: "https://helper.nearprotocol.com/account" },
    cookieSecret: SECRET,
    ...overrides,
  };
}

function senders(overrides: Partial<FaucetSenders> = {}): FaucetSenders & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sendBase: async (address) => {
      calls.push(`base:${address}`);
      return { txHash: "0xabc", amount: "2000000000000000" };
    },
    sendSolana: async (address) => {
      calls.push(`solana:${address}`);
      return { signature: "5ig", amount: "50000000" };
    },
    createNearAccount: async (accountId) => {
      calls.push(`near:${accountId}`);
      return { txHash: "8PRxQzVKKEiiAtvA3XTcC1NEbWiQUtNddyrARMdwEuoK" };
    },
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function handler(deps: { senders?: FaucetSenders; config?: FaucetConfig; limiter?: MemoryRateLimiter; now?: () => number } = {}) {
  return createFaucetHandler({
    senders: deps.senders ?? senders(),
    config: deps.config ?? config(),
    limiter: deps.limiter ?? new MemoryRateLimiter(),
    now: deps.now ?? (() => T0),
    secure: true,
  });
}

describe("GET /api/faucet", () => {
  it("reports limits and per-chain availability without secrets", async () => {
    const response = handler({ config: config({ solana: { configured: false, rpcUrl: "x", lamports: 1n } }) }).GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      limits: { perAddress: 1, perIp: 5, windowSeconds: 86400 },
      chains: {
        base: { configured: true, amount: "2000000000000000", unit: "wei" },
        solana: { configured: false, amount: "1", unit: "lamports" },
        near: { configured: true, amount: "10 NEAR", unit: "NEAR" },
      },
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});

describe("POST /api/faucet", () => {
  it("funds a Base address and sets the signed cookie", async () => {
    const mocks = senders();
    const response = await handler({ senders: mocks }).POST(post({ chain: "base", address: EVM_ADDRESS }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chain: "base", txHash: "0xabc", amount: "2000000000000000", explorerUrl: "https://sepolia.basescan.org/tx/0xabc" });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`rose_faucet=${encodeURIComponent(signCookie({ base: T0 / 1000 }, SECRET))}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(mocks.calls).toEqual([`base:${EVM_ADDRESS}`]);
  });

  it("funds a Solana address and creates a NEAR account with explorer links", async () => {
    const h = handler();
    const sol = await h.POST(post({ chain: "solana", address: SOL_ADDRESS }));
    expect(await sol.json()).toEqual({ chain: "solana", signature: "5ig", amount: "50000000", explorerUrl: "https://explorer.solana.com/tx/5ig?cluster=devnet" });
    const near = await h.POST(post({ chain: "near", accountId: "alice-demo.testnet", publicKey: NEAR_KEY }));
    expect(await near.json()).toEqual({
      chain: "near",
      accountId: "alice-demo.testnet",
      txHash: "8PRxQzVKKEiiAtvA3XTcC1NEbWiQUtNddyrARMdwEuoK",
      explorerUrl: "https://testnet.near.rocks/tx/8PRxQzVKKEiiAtvA3XTcC1NEbWiQUtNddyrARMdwEuoK",
    });
  });

  it("rejects invalid JSON and invalid fields with 400 before touching the senders", async () => {
    const mocks = senders();
    const h = handler({ senders: mocks });
    expect((await h.POST(post("{not json"))).status).toBe(400);
    const bad = await h.POST(post({ chain: "base", address: "0x1" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_request", message: expect.stringContaining("Ethereum address") });
    expect(mocks.calls).toEqual([]);
  });

  it("rate limits a second request for the same address with 429 and Retry-After", async () => {
    const mocks = senders();
    const h = handler({ senders: mocks });
    expect((await h.POST(post({ chain: "base", address: EVM_ADDRESS }))).status).toBe(200);
    const second = await h.POST(post({ chain: "base", address: EVM_ADDRESS.toLowerCase() }, { "x-forwarded-for": "2.2.2.2" }));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("86400");
    expect(await second.json()).toMatchObject({ error: "rate_limited", retryAfterSeconds: 86400, message: expect.stringContaining("address") });
    expect(mocks.calls).toHaveLength(1);
  });

  it("rate limits the same browser through the cookie even on a fresh instance", async () => {
    const cookie = signCookie({ solana: T0 / 1000 - 3600 }, SECRET);
    const response = await handler().POST(post({ chain: "solana", address: SOL_ADDRESS }, { cookie: `rose_faucet=${encodeURIComponent(cookie)}` }));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "rate_limited", retryAfterSeconds: 86400 - 3600, message: expect.stringContaining("browser") });
    const other = await handler().POST(post({ chain: "base", address: EVM_ADDRESS }, { cookie: `rose_faucet=${encodeURIComponent(cookie)}` }));
    expect(other.status).toBe(200);
  });

  it("limits five requests per ip per chain", async () => {
    const h = handler();
    for (let i = 0; i < 5; i += 1) {
      const address = `0x${(i + 1).toString(16).padStart(40, "0")}`;
      expect((await h.POST(post({ chain: "base", address }))).status).toBe(200);
    }
    const sixth = await h.POST(post({ chain: "base", address: EVM_ADDRESS }));
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({ message: expect.stringContaining("network") });
  });

  it("answers 503 when a chain or the cookie secret is not configured", async () => {
    const noBase = await handler({ config: config({ base: { configured: false, rpcUrl: "x", amountWei: 1n } }) }).POST(post({ chain: "base", address: EVM_ADDRESS }));
    expect(noBase.status).toBe(503);
    expect(await noBase.json()).toMatchObject({ error: "not_configured", message: expect.stringContaining("Base Sepolia") });
    const noSecret = await handler({ config: config({ cookieSecret: null }) }).POST(post({ chain: "solana", address: SOL_ADDRESS }));
    expect(noSecret.status).toBe(503);
  });

  it("maps sender failures to 409, 502 and 400 and does not consume the limit", async () => {
    let baseAttempts = 0;
    const mocks = senders({
      sendBase: async () => {
        baseAttempts += 1;
        if (baseAttempts === 1) throw new FaucetError("faucet_dry", "The Base Sepolia faucet wallet is empty; ask the team to refill it.");
        return { txHash: "0xretry", amount: "1" };
      },
      sendSolana: async () => {
        throw new Error("fetch failed: ECONNRESET secret=0xdeadbeef");
      },
      createNearAccount: async () => {
        throw new FaucetError("invalid_request", "That account id already exists; pick another one.");
      },
    });
    const h = handler({ senders: mocks });
    const dry = await h.POST(post({ chain: "base", address: EVM_ADDRESS }));
    expect(dry.status).toBe(409);
    expect(await dry.json()).toMatchObject({ error: "faucet_dry" });
    const upstream = await h.POST(post({ chain: "solana", address: SOL_ADDRESS }));
    expect(upstream.status).toBe(502);
    const text = await upstream.text();
    expect(text).not.toContain("deadbeef");
    expect(JSON.parse(text)).toMatchObject({ error: "upstream" });
    const near = await h.POST(post({ chain: "near", accountId: "taken.testnet", publicKey: NEAR_KEY }));
    expect(near.status).toBe(400);
    expect(dry.headers.get("set-cookie")).toBeNull();
    const retry = await h.POST(post({ chain: "base", address: EVM_ADDRESS }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ txHash: "0xretry" });
  });
});
