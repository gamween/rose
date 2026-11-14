import { NearRpc, NearRpcError } from "@rose/sdk";
import { NEAR_READ_RPC_ENDPOINTS, NEAR_RPC_URL } from "./deployment";

/** Decimals of the rose cash token (tUSDC) used for every USDC amount returned by the engine. */
export const USDC_DECIMALS = 6;

export type ViewErrorKind = "account_missing" | "no_contract" | "method_missing" | "execution" | "rpc" | "invalid_response";

export class EngineViewError extends Error {
  readonly kind: ViewErrorKind;

  constructor(kind: ViewErrorKind, message: string) {
    super(message);
    this.name = "EngineViewError";
    this.kind = kind;
  }
}

export type ViewOptions = {
  rpcUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export type ViewResult<T> = { value: T; blockHeight: number };

type RpcResponse = {
  result?: { result?: number[]; error?: string; block_height?: number };
  error?: { cause?: { name?: string }; data?: unknown; message?: string };
};

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

type QueryResult = NonNullable<RpcResponse["result"]>;

/** The shared read client of the page: FastNEAR, then dRPC, then Intear, under the page's request budget. */
const defaultRpc = new NearRpc({ endpoints: NEAR_READ_RPC_ENDPOINTS });

/**
 * One NEAR `query` (any `request_type`): through the page's shared client with fallback by
 * default, or through `options.fetchImpl` / `options.rpcUrl` when given.
 */
export function nearQuery<T>(accountId: string, params: Record<string, string>, options: ViewOptions = {}): Promise<T | undefined> {
  return options.fetchImpl || options.rpcUrl ? queryWithFetch<T>(accountId, params, options) : queryWithFallback<T>(accountId, params, options.signal);
}

async function queryWithFallback<T>(accountId: string, params: Record<string, string>, signal?: AbortSignal): Promise<T | undefined> {
  try {
    return await defaultRpc.request<T>("query", params, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (signal?.aborted) throw error;
    if (error instanceof NearRpcError && error.kind === "account_missing") throw new EngineViewError("account_missing", `Account ${accountId} does not exist on NEAR testnet.`);
    if (error instanceof NearRpcError && (error.kind === "unreachable" || error.kind === "http")) throw new EngineViewError("rpc", "The NEAR RPC could not be reached.");
    throw new EngineViewError("rpc", error instanceof Error ? error.message : "The NEAR RPC returned an error.");
  }
}

/** One endpoint and an injected `fetch` (tests, or a caller that names its RPC). */
async function queryWithFetch<T>(accountId: string, params: Record<string, string>, options: ViewOptions): Promise<T | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.rpcUrl ?? NEAR_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "rose", method: "query", params }),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new EngineViewError("rpc", "The NEAR RPC could not be reached.");
  }
  if (!response.ok) {
    throw new EngineViewError("rpc", `The NEAR RPC answered with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { result?: T; error?: RpcResponse["error"] };
  if (body.error) {
    if (body.error.cause?.name === "UNKNOWN_ACCOUNT") {
      throw new EngineViewError("account_missing", `Account ${accountId} does not exist on NEAR testnet.`);
    }
    throw new EngineViewError("rpc", typeof body.error.data === "string" ? body.error.data : "The NEAR RPC returned an error.");
  }
  return body.result;
}

/** Calls a NEAR view method through JSON-RPC (`query` / `call_function`, final finality) and parses the JSON result. */
export async function viewCall<T>(
  accountId: string,
  methodName: string,
  args: Record<string, unknown> = {},
  options: ViewOptions = {},
): Promise<ViewResult<T>> {
  const params = {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: toBase64(JSON.stringify(args)),
  };
  const result = await nearQuery<QueryResult>(accountId, params, options);
  if (!result) throw new EngineViewError("invalid_response", "The NEAR RPC returned no result.");
  if (result.error) {
    if (result.error.includes("CodeDoesNotExist")) {
      throw new EngineViewError("no_contract", `No contract is deployed on ${accountId}.`);
    }
    if (result.error.includes("MethodNotFound")) {
      throw new EngineViewError("method_missing", `The contract on ${accountId} has no ${methodName} method.`);
    }
    throw new EngineViewError("execution", result.error);
  }
  if (!Array.isArray(result.result)) throw new EngineViewError("invalid_response", "The view returned no bytes.");
  const text = new TextDecoder().decode(Uint8Array.from(result.result));
  try {
    return { value: JSON.parse(text) as T, blockHeight: result.block_height ?? 0 };
  } catch {
    throw new EngineViewError("invalid_response", "The view did not return JSON.");
  }
}
