import { Connection } from "@solana/web3.js";

/**
 * Local discard port: the connection's HTTP and websocket endpoints point there, so nothing a
 * test does can reach a real cluster even if a call bypassed the stubbed `fetch`.
 */
const NOWHERE = "127.0.0.1:9";

/**
 * A web3.js connection whose JSON-RPC calls are answered by `handler` (an `Error` becomes an RPC
 * error). Hermetic: every HTTP call goes through the stub and the websocket endpoint is local.
 */
export function stubConnection(handler: (method: string, params: unknown[]) => unknown, onRequest?: (method: string, params: unknown[]) => void): Connection {
  const fetchImpl = (_: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
    onRequest?.(body.method, body.params);
    const result = handler(body.method, body.params);
    const payload =
      result instanceof Error
        ? { jsonrpc: "2.0", id: body.id, error: { code: -32002, message: result.message, data: { logs: [] } } }
        : { jsonrpc: "2.0", id: body.id, result };
    return Promise.resolve(new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }));
  };
  return new Connection(`http://${NOWHERE}`, { commitment: "confirmed", fetch: fetchImpl, wsEndpoint: `ws://${NOWHERE}`, disableRetryOnRateLimit: true });
}
