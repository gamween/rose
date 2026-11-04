import { Connection } from "@solana/web3.js";

/** A web3.js connection whose JSON-RPC calls are answered by `handler` (an `Error` becomes an RPC error). */
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
  return new Connection("https://api.devnet.solana.com", { commitment: "confirmed", fetch: fetchImpl });
}
