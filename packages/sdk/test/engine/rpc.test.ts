import { describe, expect, it } from "vitest";
import { describeFailure, NearRpc, NearRpcError, outcomeFailure, outcomeLogs, outcomeValue, type FinalExecutionOutcome } from "../../src/engine/rpc.js";

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
