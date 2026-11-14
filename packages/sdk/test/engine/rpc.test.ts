import { describe, expect, it, vi } from "vitest";
import { cooldownMs, describeFailure, endpointOrder, MAX_CONCURRENT_RPC_REQUESTS, RPC_COOLDOWN_MS, NearRpc, NearRpcError, TokenBucket, outcomeFailure, outcomeLogs, outcomeValue, withRpcSlot, type FinalExecutionOutcome } from "../../src/engine/rpc.js";

function bytes(value: unknown): number[] {
  return [...Buffer.from(JSON.stringify(value))];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("NearRpc", () => {
  it("sends a final call_function query and decodes the JSON result", async () => {
    const seen: { url: string; body: { method: string; params: Record<string, string> } }[] = [];
    const fetchImpl: typeof globalThis.fetch = (url, init) => {
      seen.push({ url: (url as string), body: JSON.parse((init?.body as string)) as { method: string; params: Record<string, string> } });
      return Promise.resolve(json({ result: { result: bytes({ ok: true }), block_height: 42, block_hash: "h", logs: [] } }));
    };
    const rpc = new NearRpc({ fetch: fetchImpl, endpoints: ["https://a.test", "https://b.test"] });
    const result = await rpc.viewFunction<{ ok: boolean }>("engine.testnet", "stats", { x: 1 });
    expect(result).toEqual({ value: { ok: true }, blockHeight: 42, blockHash: "h", logs: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://a.test");
    expect(seen[0]?.body.method).toBe("query");
    expect(seen[0]?.body.params["request_type"]).toBe("call_function");
    expect(seen[0]?.body.params["finality"]).toBe("final");
    expect(Buffer.from(seen[0]?.body.params["args_base64"] ?? "", "base64").toString()).toBe('{"x":1}');
  });

  it("falls over to the next endpoint on a network failure and on 5xx", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = (url) => {
      urls.push((url as string));
      if (urls.length === 1) return Promise.reject(new TypeError("fetch failed"));
      if (urls.length === 2) return Promise.resolve(new Response("bad gateway", { status: 502 }));
      return Promise.resolve(json({ result: { amount: "1", locked: "0", code_hash: "x", storage_usage: 1, storage_paid_at: 0, block_height: 1, block_hash: "h" } }));
    };
    const rpc = new NearRpc({ fetch: fetchImpl, endpoints: ["https://a.test", "https://b.test", "https://c.test"] });
    const account = await rpc.viewAccount("rose-app.testnet");
    expect(account.amount).toBe("1");
    expect(urls).toEqual(["https://a.test", "https://b.test", "https://c.test"]);
  });

  it("reports unreachable when every endpoint fails", async () => {
    const rpc = new NearRpc({ fetch: () => Promise.reject(new TypeError("offline")), endpoints: ["https://a.test", "https://b.test"] });
    await expect(rpc.block()).rejects.toMatchObject({ name: "NearRpcError", kind: "unreachable" });
  });

  it("maps RPC error causes to typed kinds without retrying", async () => {
    let calls = 0;
    const rpc = new NearRpc({
      fetch: () => {
        calls += 1;
        return Promise.resolve(json({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: "x" } }));
      },
      endpoints: ["https://a.test", "https://b.test"],
    });
    await expect(rpc.viewAccount("nobody.testnet")).rejects.toMatchObject({ kind: "account_missing" });
    expect(calls).toBe(1);
  });

  it("maps view execution errors to no_contract, method_missing and execution", async () => {
    const make = (error: string) => new NearRpc({ fetch: () => Promise.resolve(json({ result: { error, logs: [] } })), endpoints: ["https://a.test"] });
    await expect(make("wasm execution failed with error: CodeDoesNotExist").viewFunction("e", "stats")).rejects.toMatchObject({ kind: "no_contract" });
    await expect(make("MethodNotFound").viewFunction("e", "stats")).rejects.toMatchObject({ kind: "method_missing" });
    const error = await make("wasm execution failed with error: HostError(GuestPanic { panic_msg: \"Round not found\" })")
      .viewFunction("e", "get_round")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NearRpcError);
    expect((error as NearRpcError).kind).toBe("execution");
  });

  it("sends signed transactions with wait_until", async () => {
    let sent: { method: string; params: Record<string, string> } | undefined;
    const outcome = { status: { SuccessValue: "" }, transaction: { hash: "H" }, transaction_outcome: { outcome: { logs: [] } }, receipts_outcome: [] };
    const rpc = new NearRpc({
      fetch: (_, init) => {
        sent = JSON.parse((init?.body as string)) as { method: string; params: Record<string, string> };
        return Promise.resolve(json({ result: outcome }));
      },
      endpoints: ["https://a.test"],
    });
    const result = await rpc.sendTransaction("AAAA", "FINAL");
    expect(result.transaction.hash).toBe("H");
    expect(sent?.method).toBe("send_tx");
    expect(sent?.params).toEqual({ signed_tx_base64: "AAAA", wait_until: "FINAL" });
  });

  it("sends a transaction to the endpoints in the order given, even to one that is pausing", async () => {
    const urls: string[] = [];
    const outcome = { status: { SuccessValue: "" }, transaction: { hash: "H" }, transaction_outcome: { outcome: { logs: [] } }, receipts_outcome: [] };
    const fetchImpl: typeof globalThis.fetch = (url, init) => {
      urls.push(url as string);
      const { method } = JSON.parse(init?.body as string) as { method: string };
      if (method === "block") return Promise.resolve(new Response("Too Many Requests", { status: 429 }));
      return Promise.resolve(json({ result: outcome }));
    };
    const rpc = new NearRpc({ fetch: fetchImpl, endpoints: ["https://send-a.test", "https://send-b.test"] });
    await expect(rpc.block("final")).rejects.toThrow(NearRpcError);
    expect(cooldownMs("https://send-a.test")).toBeGreaterThan(0);
    urls.length = 0;
    await rpc.sendTransaction("AAAA");
    expect(urls).toEqual(["https://send-a.test"]);
  });
});

describe("outcome helpers", () => {
  const outcome: FinalExecutionOutcome = {
    status: { SuccessValue: Buffer.from("3").toString("base64") },
    transaction: { hash: "H", signer_id: "a.testnet", receiver_id: "engine.testnet", nonce: 1, public_key: "ed25519:x" },
    transaction_outcome: { id: "t", outcome: { logs: ["one"], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "a.testnet", status: { SuccessReceiptId: "r" } } },
    receipts_outcome: [
      { id: "r", outcome: { logs: ["two"], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "engine.testnet", status: { SuccessValue: "" } } },
    ],
  };

  it("collects logs in execution order and the return value", () => {
    expect(outcomeLogs(outcome)).toEqual(["one", "two"]);
    expect(outcomeValue(outcome)).toBe(3);
    expect(outcomeFailure(outcome)).toBeNull();
  });

  it("finds a receipt failure and describes a contract panic", () => {
    const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Insufficient cash" } } } };
    const receipt = outcome.receipts_outcome[0];
    if (!receipt) throw new Error("fixture has one receipt");
    const failed: FinalExecutionOutcome = {
      ...outcome,
      status: { Failure: failure },
      receipts_outcome: [{ ...receipt, outcome: { ...receipt.outcome, status: { Failure: failure } } }],
    };
    expect(outcomeFailure(failed)).toBe(failure);
    expect(describeFailure(failure)).toBe("Insufficient cash");
    expect(describeFailure({ ActionError: { index: 0, kind: { AccountAlreadyExists: { account_id: "x" } } } })).toBe("Account Already Exists");
    expect(describeFailure({ InvalidTxError: { InvalidNonce: {} } })).toBe("Invalid Nonce");
    expect(describeFailure(null)).toBe("The transaction failed.");
  });
});

describe("RPC concurrency", () => {
  it("never runs more than the limit of requests at once and runs every request", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        withRpcSlot(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return index;
        }),
      ),
    );
    expect(peak).toBe(MAX_CONCURRENT_RPC_REQUESTS);
    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index));
  });

  it("frees the slot when a request fails", async () => {
    await Promise.all(Array.from({ length: 6 }, () => withRpcSlot(() => Promise.reject(new Error("down"))).catch(() => null)));
    await expect(withRpcSlot(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("RPC request budget", () => {
  it("spends its capacity, then refills at its rate", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 2, () => now);
    expect(bucket.waitMs()).toBe(0);
    void bucket.take();
    void bucket.take();
    expect(bucket.waitMs()).toBe(500);
    now = 500;
    expect(bucket.waitMs()).toBe(0);
  });

  it("starts with the first endpoint that has budget left", () => {
    const waits: Record<string, number> = { a: 300, b: 0 };
    expect(endpointOrder(["a", "b"], (endpoint) => waits[endpoint] ?? 0)).toEqual(["b", "a"]);
    expect(endpointOrder(["a", "b"], () => 100)).toEqual(["a", "b"]);
  });

  it("passes over an endpoint that just refused, for the following requests too, until it answers again", async () => {
    const urls: string[] = [];
    let limited = true;
    const fetchImpl: typeof globalThis.fetch = (url) => {
      urls.push(url as string);
      if (url === "https://cool-a.test" && limited) return Promise.resolve(new Response("Too Many Requests", { status: 429 }));
      return Promise.resolve(json({ result: { header: { height: urls.length } } }));
    };
    const rpc = new NearRpc({ fetch: fetchImpl, endpoints: ["https://cool-a.test", "https://cool-b.test"] });
    await rpc.block("final");
    expect(urls).toEqual(["https://cool-a.test", "https://cool-b.test"]);
    expect(cooldownMs("https://cool-a.test")).toBeGreaterThan(RPC_COOLDOWN_MS - 1_000);
    await rpc.block("optimistic");
    expect(urls.slice(2)).toEqual(["https://cool-b.test"]);
    expect(cooldownMs("https://cool-a.test", Date.now() + RPC_COOLDOWN_MS)).toBe(0);
    limited = false;
    const direct = new NearRpc({ fetch: fetchImpl, endpoints: ["https://cool-a.test"] });
    await direct.block("final");
    expect(cooldownMs("https://cool-a.test")).toBe(0);
  });

  it("keeps the pause when an answer to a request sent before the refusal lands after it", async () => {
    const endpoint = "https://cool-burst.test";
    const answers: ((response: Response) => void)[] = [];
    const fetchImpl: typeof globalThis.fetch = () => new Promise<Response>((resolve) => answers.push(resolve));
    const rpc = new NearRpc({ fetch: fetchImpl, endpoints: [endpoint] });
    const early = rpc.block("final");
    const limited = rpc.block("optimistic").catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(answers).toHaveLength(2);
    });
    answers[1]?.(new Response("Too Many Requests", { status: 429 }));
    expect(await limited).toBeInstanceOf(NearRpcError);
    expect(cooldownMs(endpoint)).toBeGreaterThan(RPC_COOLDOWN_MS - 1_000);
    answers[0]?.(json({ result: { header: { height: 1 } } }));
    await early;
    expect(cooldownMs(endpoint)).toBeGreaterThan(RPC_COOLDOWN_MS - 1_000);
    const later = rpc.block("final");
    await vi.waitFor(() => {
      expect(answers).toHaveLength(3);
    });
    answers[2]?.(json({ result: { header: { height: 2 } } }));
    await later;
    expect(cooldownMs(endpoint)).toBe(0);
  });

  it("shares one round trip between identical requests in flight", async () => {
    let calls = 0;
    const rpc = new NearRpc({
      endpoints: ["http://dedupe.test"],
      fetch: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "rose", result: { header: { height: 7 } } }));
      },
    });
    const controller = new AbortController();
    const [a, b] = await Promise.all([rpc.block("final"), rpc.block("final", controller.signal)]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    await rpc.block("final");
    expect(calls).toBe(2);
  });
});
