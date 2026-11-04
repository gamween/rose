import { NearRpc, NearRpcError } from "@rose/sdk";

export const NEAR_TESTNET_RPC = "https://test.rpc.fastnear.com";
export const NEAR_TESTNET_RPC_FALLBACK = "https://rpc.testnet.near.org";

/** Decimals of the rose cash token (tUSDC) used for every USDC amount returned by the engine. */
export const USDC_DECIMALS = 6;

/**
 * Raw JSON returned by the engine `stats` view method.
 * Counters are `u64` serialized as JSON numbers; the settled volume is a `U128` (decimal string)
 * in USDC base units (6 decimals).
 */
export type EngineStatsView = {
  rounds_total: number;
  rounds_settled: number;
  volume_settled_usdc: string;
  classes: number;
  positions: number;
};

export type EngineStats = {
  roundsTotal: number;
  roundsSettled: number;
  volumeSettledUsdc: bigint;
  classes: number;
  positions: number;
};

export type NotDeployedReason = "account_not_configured" | "account_missing" | "no_contract" | "method_missing";

export type StatsResult =
  | { status: "ok"; account: string; stats: EngineStats; blockHeight: number }
  | { status: "not_deployed"; account: string | null; reason: NotDeployedReason };

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

/** The engine account from `NEXT_PUBLIC_ENGINE_ACCOUNT`, or null while the engine is not deployed. */
export function configuredEngineAccount(): string | null {
  const value = process.env.NEXT_PUBLIC_ENGINE_ACCOUNT?.trim();
  return value ? value : null;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

type QueryResult = NonNullable<RpcResponse["result"]>;

/** The shared client of the page: FastNEAR, then rpc.testnet.near.org, under the page's request budget. */
const defaultRpc = new NearRpc({ endpoints: [NEAR_TESTNET_RPC, NEAR_TESTNET_RPC_FALLBACK] });

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
    response = await fetchImpl(options.rpcUrl ?? NEAR_TESTNET_RPC, {
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

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates the raw `stats` view and converts it to typed values. */
export function parseEngineStats(raw: unknown): EngineStats {
  if (typeof raw !== "object" || raw === null) {
    throw new EngineViewError("invalid_response", "stats did not return an object.");
  }
  const view = raw as Partial<Record<keyof EngineStatsView, unknown>>;
  const counters = ["rounds_total", "rounds_settled", "classes", "positions"] as const;
  for (const key of counters) {
    if (!isCounter(view[key])) throw new EngineViewError("invalid_response", `stats.${key} is not a counter.`);
  }
  const volume = view.volume_settled_usdc;
  if (typeof volume !== "string" || !/^\d+$/.test(volume)) {
    throw new EngineViewError("invalid_response", "stats.volume_settled_usdc is not a U128 string.");
  }
  const checked = view as EngineStatsView;
  return {
    roundsTotal: checked.rounds_total,
    roundsSettled: checked.rounds_settled,
    volumeSettledUsdc: BigInt(volume),
    classes: checked.classes,
    positions: checked.positions,
  };
}

const NOT_DEPLOYED_KINDS: Partial<Record<ViewErrorKind, NotDeployedReason>> = {
  account_missing: "account_missing",
  no_contract: "no_contract",
  method_missing: "method_missing",
};

/** Reads the protocol stats; a missing account, contract or method is reported as "not deployed", other failures throw. */
export async function fetchEngineStats(
  account: string | null = configuredEngineAccount(),
  options: ViewOptions = {},
): Promise<StatsResult> {
  if (!account) return { status: "not_deployed", account: null, reason: "account_not_configured" };
  try {
    const { value, blockHeight } = await viewCall<unknown>(account, "stats", {}, options);
    return { status: "ok", account, stats: parseEngineStats(value), blockHeight };
  } catch (error) {
    if (error instanceof EngineViewError) {
      const reason = NOT_DEPLOYED_KINDS[error.kind];
      if (reason) return { status: "not_deployed", account, reason };
    }
    throw error;
  }
}
