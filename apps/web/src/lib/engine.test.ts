import { describe, expect, it } from "vitest";
import { EngineViewError, fetchEngineStats, parseEngineStats, viewCall } from "./engine";

function rpc(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

function bytes(value: unknown): number[] {
  return [...new TextEncoder().encode(JSON.stringify(value))];
}

const stats = { rounds_total: 3, rounds_settled: 2, volume_settled_usdc: "125000000000", classes: 3, positions: 6 };

describe("engine view helper", () => {
  it("sends a final call_function query with base64 JSON args", async () => {
    let sent: { method: string; params: Record<string, string> } | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: { result: bytes("ok"), block_height: 7 } }));
    }) as typeof fetch;
    const result = await viewCall<string>("engine.rose-app.testnet", "stats", { a: 1 }, { fetchImpl });
    expect(result).toEqual({ value: "ok", blockHeight: 7 });
    expect(sent?.method).toBe("query");
    expect(sent?.params.request_type).toBe("call_function");
    expect(sent?.params.finality).toBe("final");
    expect(atob(sent!.params.args_base64!)).toBe('{"a":1}');
  });

  it("parses and validates the stats view", async () => {
    const result = await fetchEngineStats("engine.rose-app.testnet", { fetchImpl: rpc({ result: { result: bytes(stats), block_height: 42 } }) });
    expect(result).toEqual({
      status: "ok",
      account: "engine.rose-app.testnet",
      blockHeight: 42,
      stats: { roundsTotal: 3, roundsSettled: 2, volumeSettledUsdc: 125000000000n, classes: 3, positions: 6 },
    });
  });

  it("reports an unset account as not deployed without calling the RPC", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as typeof fetch;
    expect(await fetchEngineStats(null, { fetchImpl })).toEqual({ status: "not_deployed", account: null, reason: "account_not_configured" });
  });

  it("maps the live RPC errors for a missing account, contract or method to not deployed", async () => {
    const missingAccount = rpc({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: "account x does not exist while viewing" } });
    const noContract = rpc({ result: { error: 'wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "x" })', logs: [] } });
    const noMethod = rpc({ result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)", logs: [] } });
    expect((await fetchEngineStats("x", { fetchImpl: missingAccount })).status).toBe("not_deployed");
    expect(await fetchEngineStats("x", { fetchImpl: noContract })).toMatchObject({ reason: "no_contract" });
    expect(await fetchEngineStats("x", { fetchImpl: noMethod })).toMatchObject({ reason: "method_missing" });
  });

  it("throws on transport failures and malformed stats", async () => {
    await expect(fetchEngineStats("x", { fetchImpl: rpc({}, 503) })).rejects.toBeInstanceOf(EngineViewError);
    expect(() => parseEngineStats({ ...stats, volume_settled_usdc: 12 })).toThrow(EngineViewError);
    expect(() => parseEngineStats({ ...stats, positions: -1 })).toThrow(EngineViewError);
  });
});
