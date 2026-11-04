import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createFaucetSenders, DEFAULT_CAPS, DEFAULT_NEAR_FUNDER_YOCTO, FaucetError, nearAmountLabel, readFaucetConfig } from "./chains";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

const NEAR_KEY = "ed25519:8bWAWmjS8VxkwUiGJKyjEFZesSxchRZQ1YF5K6Xq8vu9";
const NEAR_RPC = "https://test.rpc.fastnear.com";

/** Routes the NEAR RPC (the account does not exist yet) and the helper to `helper`. */
function nearFetch(helper: () => Response) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(NEAR_RPC)) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "rose-faucet", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: "Server error" } }), { status: 200 });
    }
    return helper();
  });
}

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
    vi.stubGlobal("fetch", nearFetch(() => new Response(JSON.stringify({ transaction: { hash: "Hx" }, status: { SuccessValue: "" } }), { status: 200 })));
    const senders = createFaucetSenders(env({}));
    await expect(senders.createNearAccount("alice-demo.testnet", NEAR_KEY)).resolves.toEqual({ txHash: "Hx", amount: "10 NEAR" });
  });

  it("surfaces a rate-limited helper when no funder account is configured", async () => {
    vi.stubGlobal("fetch", nearFetch(() => new Response("Rate limit exceeded, retry in 7 hours.", { status: 429 })));
    const senders = createFaucetSenders(env({}));
    const error = await senders.createNearAccount("alice-demo.testnet", NEAR_KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FaucetError);
    expect((error as FaucetError).code).toBe("upstream");
    expect((error as FaucetError).message).toBe("The NEAR faucet helper answered HTTP 429: Rate limit exceeded, retry in 7 hours..");
  });

  it("never falls back on a request the helper refused as invalid", async () => {
    const fetchMock = nearFetch(() => new Response("account id is invalid", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const senders = createFaucetSenders(env({ NEAR_FAUCET_ACCOUNT_ID: "rose-faucet.testnet", NEAR_FAUCET_PRIVATE_KEY: NEAR_KEY }));
    const error = await senders.createNearAccount("bad.testnet", NEAR_KEY).catch((e: unknown) => e);
    expect((error as FaucetError).code).toBe("invalid_request");
    /* One RPC read of the account, one helper call, and no funder transaction. */
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses an account id that already exists before calling the helper", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "rose-faucet", result: { amount: "1" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await createFaucetSenders(env({})).createNearAccount("taken.testnet", NEAR_KEY).catch((e: unknown) => e);
    expect((error as FaucetError).code).toBe("invalid_request");
    expect((error as FaucetError).message).toContain("already exists");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("faucet caps configuration", () => {
  it("defaults the global caps per chain and reads overrides", () => {
    const defaults = readFaucetConfig(env({}));
    expect(defaults.base.caps).toEqual(DEFAULT_CAPS.base);
    expect(defaults.solana.caps).toEqual(DEFAULT_CAPS.solana);
    expect(defaults.near.funderCaps).toEqual(DEFAULT_CAPS.near);
    const custom = readFaucetConfig(env({ BASE_FAUCET_HOURLY_CAP: "2", BASE_FAUCET_DAILY_CAP: "4", SOLANA_FAUCET_DAILY_CAP: "x" }));
    expect(custom.base.caps).toEqual({ hourly: 2, daily: 4 });
    expect(custom.solana.caps).toEqual(DEFAULT_CAPS.solana);
  });
});

describe("Base sender", () => {
  /* A throwaway key generated for this test; it holds nothing on any chain. */
  const KEY = "0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63";
  const HOT = privateKeyToAccount(KEY).address;
  const RECIPIENT = "0x00000000000000000000000000000000000000aa";
  const NOW = 1_800_000_000_000;

  type Rpc = { method: string; params: unknown[] };

  /** A Base Sepolia JSON-RPC stub: 0.2 s blocks, `sent` transactions from the hot wallet in the last hour. */
  function baseRpc(options: { recipientWei?: bigint; sent?: number; rawAnswers?: ({ error: string } | { hash: string })[] }) {
    const methods: string[] = [];
    const answers = [...(options.rawAnswers ?? [{ hash: `0x${"ab".repeat(32)}` }])];
    const head = 1_000_000;
    const hex = (value: number | bigint) => `0x${value.toString(16)}`;
    const answer = ({ method, params }: Rpc): unknown => {
      methods.push(method);
      switch (method) {
        case "eth_chainId":
          return hex(84532);
        case "eth_blockNumber":
          return hex(head);
        case "eth_getBlockByNumber": {
          const tag = params[0] as string;
          const number = tag === "latest" || tag === "pending" ? head : Number.parseInt(tag, 16);
          return { number: hex(number), timestamp: hex(Math.floor(NOW / 1000) - Math.floor((head - number) / 5)), baseFeePerGas: hex(1_000_000), hash: `0x${"11".repeat(32)}`, transactions: [] };
        }
        case "eth_getBalance":
          return hex((params[0] as string).toLowerCase() === HOT.toLowerCase() ? 10n ** 18n : (options.recipientWei ?? 0n));
        case "eth_getTransactionCount":
          return params[1] === "pending" || params[1] === "latest" ? hex(10 + (options.sent ?? 0)) : hex(10);
        case "eth_maxPriorityFeePerGas":
          return hex(1_000);
        case "eth_gasPrice":
          return hex(2_000_000);
        case "eth_estimateGas":
          return hex(21_000);
        case "eth_sendRawTransaction": {
          const next = answers.shift() ?? { hash: `0x${"ab".repeat(32)}` };
          if ("error" in next) throw new Error(next.error);
          return next.hash;
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    };
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as (Rpc & { id: number }) | (Rpc & { id: number })[];
      const one = (call: Rpc & { id: number }) => {
        try {
          return { jsonrpc: "2.0", id: call.id, result: answer(call) };
        } catch (error) {
          return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: (error as Error).message } };
        }
      };
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
    });
    return { fetchMock, methods };
  }

  function sender() {
    const values = { BASE_FAUCET_PRIVATE_KEY: KEY };
    return createFaucetSenders(env(values), readFaucetConfig(env(values)), () => NOW);
  }

  it("refuses an address that already holds what the faucet sends", async () => {
    const { fetchMock, methods } = baseRpc({ recipientWei: 3_000_000_000_000_000n });
    vi.stubGlobal("fetch", fetchMock);
    const error = await sender().sendBase(RECIPIENT).catch((e: unknown) => e);
    expect((error as FaucetError).code).toBe("already_funded");
    expect(methods).not.toContain("eth_sendRawTransaction");
  });

  it("refuses once the hot wallet's own nonce history shows a full hourly cap", async () => {
    const { fetchMock, methods } = baseRpc({ sent: DEFAULT_CAPS.base.hourly });
    vi.stubGlobal("fetch", fetchMock);
    const error = await sender().sendBase(RECIPIENT).catch((e: unknown) => e);
    expect((error as FaucetError).code).toBe("rate_limited");
    expect((error as FaucetError).message).toContain(`${String(DEFAULT_CAPS.base.hourly)} sends per hour`);
    expect(methods).not.toContain("eth_sendRawTransaction");
  });

  it("retries once with a fresh nonce when another instance used the same one", async () => {
    const { fetchMock, methods } = baseRpc({ rawAnswers: [{ error: "nonce too low: next nonce 11, tx nonce 10" }, { hash: `0x${"cd".repeat(32)}` }] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(sender().sendBase(RECIPIENT)).resolves.toEqual({ txHash: `0x${"cd".repeat(32)}`, amount: "2000000000000000" });
    expect(methods.filter((method) => method === "eth_sendRawTransaction")).toHaveLength(2);
  });
});
