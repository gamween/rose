import { EngineViewError, nearQuery as engineQuery, type ViewOptions } from "@/lib/engine";

export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

export type AccessKeyListResult = { block_height: number; block_hash: string; keys: unknown[] };

export type AccountViewResult = {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
  block_height: number;
  block_hash: string;
};

type JsonRpcResponse<T> = { result?: T; error?: { message?: string; data?: unknown; cause?: { name?: string } } };

async function postJson<T>(url: string, body: unknown, options: ViewOptions): Promise<JsonRpcResponse<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new EngineViewError("rpc", `${new URL(url).host} could not be reached.`);
  }
  if (!response.ok) throw new EngineViewError("rpc", `${new URL(url).host} answered with HTTP ${response.status}.`);
  return (await response.json()) as JsonRpcResponse<T>;
}

async function nearQuery<T>(params: Record<string, string>, options: ViewOptions): Promise<T> {
  const result = await engineQuery<T>(params.account_id ?? "", params, options);
  if (!result) throw new EngineViewError("invalid_response", "The NEAR RPC returned no result.");
  return result;
}

/** `view_access_key_list`: the raw list of full-access and function-call keys of an account. */
export function viewAccessKeyList(accountId: string, options: ViewOptions = {}): Promise<AccessKeyListResult> {
  return nearQuery<AccessKeyListResult>({ request_type: "view_access_key_list", finality: "final", account_id: accountId }, options);
}

/** `view_account`: balance, storage and the sha256 (base58) of the deployed wasm. */
export function viewAccount(accountId: string, options: ViewOptions = {}): Promise<AccountViewResult> {
  return nearQuery<AccountViewResult>({ request_type: "view_account", finality: "final", account_id: accountId }, options);
}

/** `code_hash` of an account without a contract. */
export const EMPTY_CODE_HASH = "11111111111111111111111111111111";

/** EVM `eth_call` of a zero-argument getter; returns the raw hex return data. */
export async function ethCall(to: string, selector: string, options: ViewOptions = {}): Promise<string> {
  const body = await postJson<string>(
    options.rpcUrl ?? BASE_SEPOLIA_RPC,
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data: selector }, "latest"] },
    options,
  );
  if (body.error) throw new EngineViewError("execution", body.error.message ?? "The Base RPC returned an error.");
  if (typeof body.result !== "string") throw new EngineViewError("invalid_response", "eth_call returned no data.");
  return body.result;
}

/** `eth_getCode`: `0x` when no contract is deployed at the address. */
export async function ethGetCode(address: string, options: ViewOptions = {}): Promise<string> {
  const body = await postJson<string>(options.rpcUrl ?? BASE_SEPOLIA_RPC, { jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }, options);
  if (body.error) throw new EngineViewError("execution", body.error.message ?? "The Base RPC returned an error.");
  if (typeof body.result !== "string") throw new EngineViewError("invalid_response", "eth_getCode returned no data.");
  return body.result;
}

/** Solana `getBalance` at `finalized`, in lamports. */
export async function solanaBalance(address: string, options: ViewOptions = {}): Promise<{ lamports: bigint; slot: number }> {
  const body = await postJson<{ context: { slot: number }; value: number }>(
    options.rpcUrl ?? SOLANA_DEVNET_RPC,
    { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address, { commitment: "finalized" }] },
    options,
  );
  if (body.error) throw new EngineViewError("execution", body.error.message ?? "The Solana RPC returned an error.");
  if (!body.result || typeof body.result.value !== "number") throw new EngineViewError("invalid_response", "getBalance returned no value.");
  return { lamports: BigInt(body.result.value), slot: body.result.context.slot };
}

/** Function selectors of the getters the status page reads (keccak-256 of the signature, first 4 bytes). */
export const SELECTORS = {
  "SIGNER()": "0x582abd12",
  "LOCKUP()": "0x845aef4b",
  "symbol()": "0x95d89b41",
  "decimals()": "0x313ce567",
  "totalSupply()": "0x18160ddd",
  "balanceOf(address)": "0x70a08231",
} as const;

/** Call data of `balanceOf(holder)`: the selector and the address left-padded to one word. */
export function balanceOfData(holder: string): string {
  return `${SELECTORS["balanceOf(address)"]}${holder.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/** EVM `eth_getBalance` at `latest`, in wei. */
export async function ethBalance(address: string, options: ViewOptions = {}): Promise<bigint> {
  const body = await postJson<string>(options.rpcUrl ?? BASE_SEPOLIA_RPC, { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }, options);
  if (body.error) throw new EngineViewError("execution", body.error.message ?? "The Base RPC returned an error.");
  if (typeof body.result !== "string") throw new EngineViewError("invalid_response", "eth_getBalance returned no value.");
  return BigInt(body.result);
}

function word(hex: string, index: number): string {
  const start = 2 + index * 64;
  const slice = hex.slice(start, start + 64);
  if (slice.length !== 64) throw new EngineViewError("invalid_response", "ABI return data is too short.");
  return slice;
}

/** Decodes a single `address` return value. */
export function decodeAddress(hex: string): string {
  return `0x${word(hex, 0).slice(24)}`;
}

/** Decodes a single `uint256` (or narrower) return value. */
export function decodeUint(hex: string): bigint {
  return BigInt(`0x${word(hex, 0)}`);
}

/** Decodes a single dynamic `string` return value. */
export function decodeString(hex: string): string {
  const offset = Number(decodeUint(hex));
  const length = Number(BigInt(`0x${hex.slice(2 + offset * 2, 2 + offset * 2 + 64)}`));
  const start = 2 + offset * 2 + 64;
  const bytes = hex.slice(start, start + length * 2);
  if (bytes.length !== length * 2) throw new EngineViewError("invalid_response", "ABI string is truncated.");
  return new TextDecoder().decode(Uint8Array.from(bytes.match(/../g) ?? [], (pair) => parseInt(pair, 16)));
}
