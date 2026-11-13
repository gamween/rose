import { describe, expect, it } from "vitest";
import { EngineViewError, viewCall } from "./engine";

function rpc(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

function bytes(value: unknown): number[] {
  return [...new TextEncoder().encode(JSON.stringify(value))];
}

describe("engine view helper", () => {
  it("sends a final call_function query with base64 JSON args", async () => {
    let sent: { method: string; params: Record<string, string> } | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: { result: bytes("ok"), block_height: 7 } }));
    }) as typeof fetch;
    const result = await viewCall<string>("engine.rose-app.testnet", "get_config", { a: 1 }, { fetchImpl });
    expect(result).toEqual({ value: "ok", blockHeight: 7 });
    expect(sent?.method).toBe("query");
    expect(sent?.params.request_type).toBe("call_function");
    expect(sent?.params.finality).toBe("final");
    expect(atob(sent!.params.args_base64!)).toBe('{"a":1}');
  });

  it("classifies the live RPC errors for a missing account, contract or method", async () => {
    const missingAccount = rpc({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: "account x does not exist while viewing" } });
    const noContract = rpc({ result: { error: 'wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "x" })', logs: [] } });
    const noMethod = rpc({ result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)", logs: [] } });
    await expect(viewCall("x", "get_config", {}, { fetchImpl: missingAccount })).rejects.toMatchObject({ kind: "account_missing" });
    await expect(viewCall("x", "get_config", {}, { fetchImpl: noContract })).rejects.toMatchObject({ kind: "no_contract" });
    await expect(viewCall("x", "get_config", {}, { fetchImpl: noMethod })).rejects.toMatchObject({ kind: "method_missing" });
  });

  it("throws on transport failures and non-JSON results", async () => {
    await expect(viewCall("x", "get_config", {}, { fetchImpl: rpc({}, 503) })).rejects.toBeInstanceOf(EngineViewError);
    await expect(viewCall("x", "get_config", {}, { fetchImpl: rpc({ result: { result: [0x7b], block_height: 1 } }) })).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
