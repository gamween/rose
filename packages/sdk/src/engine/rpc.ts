/**
 * Minimal NEAR JSON-RPC client over `fetch` with endpoint fallback. The web app reads the engine
 * through it (no indexer) and the demo wallets send transactions through it.
 *
 * @module
 */

import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from "../encoding.js";

/** FastNEAR testnet RPC, the primary endpoint (spec section 6). */
export const NEAR_TESTNET_RPC = "https://test.rpc.fastnear.com";
/** Official testnet RPC, used when FastNEAR is unreachable. */
export const NEAR_TESTNET_RPC_FALLBACK = "https://rpc.testnet.near.org";

export type NearRpcErrorKind =
  | "unreachable"
  | "http"
  | "account_missing"
  | "no_contract"
  | "method_missing"
  | "execution"
  | "invalid_response"
  | "rpc";

/** Error raised by every method of [`NearRpc`]; `kind` lets the caller map it to a user message. */
export class NearRpcError extends Error {
  readonly kind: NearRpcErrorKind;
  readonly data: unknown;

  constructor(kind: NearRpcErrorKind, message: string, data?: unknown) {
    super(message);
    this.name = "NearRpcError";
    this.kind = kind;
    this.data = data;
  }
}

export interface NearRpcOptions {
  /** Endpoints tried in order; a network failure or a 5xx/429 answer moves to the next one. */
  endpoints?: readonly string[];
  fetch?: typeof globalThis.fetch;
  /** Milliseconds before one request is abandoned (default 15 s). */
  timeoutMs?: number;
}

interface RpcEnvelope {
  result?: unknown;
  error?: { name?: string; cause?: { name?: string; info?: unknown }; data?: unknown; message?: string };
}

export interface ViewFunctionResult<T> { value: T; blockHeight: number; blockHash: string; logs: string[] }

export interface AccountView {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
  storage_paid_at: number;
  block_height: number;
  block_hash: string;
}

export type AccessKeyPermission = "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
export interface AccessKeyView { nonce: number; permission: AccessKeyPermission; block_height: number; block_hash: string }
export interface AccessKeyListView { keys: { public_key: string; access_key: { nonce: number; permission: AccessKeyPermission } }[] }

export type ExecutionStatus =
  | { SuccessValue: string }
  | { SuccessReceiptId: string }
  | { Failure: unknown }
  | "Unknown";

export interface ExecutionOutcomeWithId {
  id: string;
  outcome: { logs: string[]; receipt_ids: string[]; gas_burnt: number; tokens_burnt: string; executor_id: string; status: ExecutionStatus };
}

/** `FinalExecutionOutcome` of a sent transaction as returned by `send_tx` and `tx`. */
export interface FinalExecutionOutcome {
  status: ExecutionStatus;
  transaction: { hash: string; signer_id: string; receiver_id: string; nonce: number; public_key: string };
  transaction_outcome: ExecutionOutcomeWithId;
  receipts_outcome: ExecutionOutcomeWithId[];
}

export interface BlockView { header: { height: number; hash: string; timestamp: number; timestamp_nanosec: string } }

export type TxWaitUntil = "NONE" | "INCLUDED" | "EXECUTED_OPTIMISTIC" | "INCLUDED_FINAL" | "EXECUTED" | "FINAL";


function isRetriable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** JSON-RPC client for NEAR testnet with endpoint fallback and typed errors. */
export class NearRpc {
  readonly endpoints: readonly string[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: NearRpcOptions = {}) {
    this.endpoints = options.endpoints ?? [NEAR_TESTNET_RPC, NEAR_TESTNET_RPC_FALLBACK];
    // Bound through a closure: a detached `window.fetch` throws "Illegal invocation" in browsers.
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (this.endpoints.length === 0) throw new NearRpcError("rpc", "At least one RPC endpoint is required.");
  }

  /** Sends one JSON-RPC request, falling over to the next endpoint on network or server failures. */
  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    let lastError: NearRpcError | null = null;
    for (const endpoint of this.endpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
      const onAbort = () => { controller.abort(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        let response: Response;
        try {
          response = await this.fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "rose", method, params }),
            signal: controller.signal,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          lastError = new NearRpcError("unreachable", `${endpoint} could not be reached.`, error);
          continue;
        }
        if (!response.ok) {
          lastError = new NearRpcError("http", `${endpoint} answered with HTTP ${String(response.status)}.`);
          if (isRetriable(response.status)) continue;
          throw lastError;
        }
        let body: RpcEnvelope;
        try {
          body = (await response.json()) as RpcEnvelope;
        } catch {
          lastError = new NearRpcError("invalid_response", `${endpoint} returned a non-JSON body.`);
          continue;
        }
        if (body.error) throw NearRpc.toError(body.error);
        if (body.result === undefined) throw new NearRpcError("invalid_response", "The RPC returned no result.");
        return body.result as T;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastError ?? new NearRpcError("unreachable", "No RPC endpoint answered.");
  }

  private static toError(error: NonNullable<RpcEnvelope["error"]>): NearRpcError {
    const cause = error.cause?.name;
    if (cause === "UNKNOWN_ACCOUNT") return new NearRpcError("account_missing", "The account does not exist on NEAR testnet.", error);
    if (cause === "NO_CONTRACT_CODE") return new NearRpcError("no_contract", "No contract is deployed on this account.", error);
    const data = typeof error.data === "string" ? error.data : error.message;
    if (typeof error.data === "string" && error.data.includes("MethodNotFound")) {
      return new NearRpcError("method_missing", "The contract has no such method.", error);
    }
    return new NearRpcError("rpc", data ?? "The NEAR RPC returned an error.", error);
  }

  /** `query` / `call_function` at final finality; the result is parsed as JSON. */
  async viewFunction<T>(accountId: string, methodName: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ViewFunctionResult<T>> {
    const result = await this.request<{ result?: number[]; error?: string; block_height?: number; block_hash?: string; logs?: string[] }>(
      "query",
      {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: bytesToBase64(utf8ToBytes(JSON.stringify(args))),
      },
      signal,
    );
    if (result.error !== undefined) {
      if (result.error.includes("CodeDoesNotExist")) throw new NearRpcError("no_contract", `No contract is deployed on ${accountId}.`);
      if (result.error.includes("MethodNotFound")) throw new NearRpcError("method_missing", `${accountId} has no ${methodName} method.`);
      throw new NearRpcError("execution", result.error);
    }
    if (!Array.isArray(result.result)) throw new NearRpcError("invalid_response", "The view returned no bytes.");
    const text = bytesToUtf8(Uint8Array.from(result.result));
    try {
      return { value: JSON.parse(text) as T, blockHeight: result.block_height ?? 0, blockHash: result.block_hash ?? "", logs: result.logs ?? [] };
    } catch {
      throw new NearRpcError("invalid_response", `${methodName} did not return JSON.`);
    }
  }

  viewAccount(accountId: string, signal?: AbortSignal): Promise<AccountView> {
    return this.request<AccountView>("query", { request_type: "view_account", finality: "final", account_id: accountId }, signal);
  }

  viewAccessKey(accountId: string, publicKey: string, signal?: AbortSignal): Promise<AccessKeyView> {
    return this.request<AccessKeyView>(
      "query",
      { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      signal,
    );
  }

  viewAccessKeyList(accountId: string, signal?: AbortSignal): Promise<AccessKeyListView> {
    return this.request<AccessKeyListView>("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId }, signal);
  }

  block(finality: "final" | "optimistic" = "final", signal?: AbortSignal): Promise<BlockView> {
    return this.request<BlockView>("block", { finality }, signal);
  }

  /** Sends a signed transaction (base64 of the borsh `SignedTransaction`) and waits for `waitUntil`. */
  sendTransaction(signedTxBase64: string, waitUntil: TxWaitUntil = "EXECUTED_OPTIMISTIC", signal?: AbortSignal): Promise<FinalExecutionOutcome> {
    return this.request<FinalExecutionOutcome>("send_tx", { signed_tx_base64: signedTxBase64, wait_until: waitUntil }, signal);
  }

  /** Status of a transaction by hash, including every receipt's logs. */
  transactionStatus(txHash: string, senderAccountId: string, waitUntil: TxWaitUntil = "EXECUTED_OPTIMISTIC", signal?: AbortSignal): Promise<FinalExecutionOutcome> {
    return this.request<FinalExecutionOutcome>("tx", { tx_hash: txHash, sender_account_id: senderAccountId, wait_until: waitUntil }, signal);
  }
}

/** Every log line of every receipt of an outcome, in execution order. */
export function outcomeLogs(outcome: FinalExecutionOutcome): string[] {
  return [outcome.transaction_outcome, ...outcome.receipts_outcome].flatMap((entry) => entry.outcome.logs);
}

/** The `Failure` of a transaction or any of its receipts, or null when everything succeeded. */
export function outcomeFailure(outcome: FinalExecutionOutcome): unknown {
  const failed = [outcome.transaction_outcome, ...outcome.receipts_outcome].find(
    (entry) => typeof entry.outcome.status === "object" && "Failure" in entry.outcome.status,
  );
  if (failed && typeof failed.outcome.status === "object" && "Failure" in failed.outcome.status) return failed.outcome.status.Failure;
  if (typeof outcome.status === "object" && "Failure" in outcome.status) return outcome.status.Failure;
  return null;
}

/** The JSON return value of the transaction's function call, when it succeeded with a value. */
export function outcomeValue(outcome: FinalExecutionOutcome): unknown {
  if (typeof outcome.status === "object" && "SuccessValue" in outcome.status) {
    const raw = bytesToUtf8(base64ToBytes(outcome.status.SuccessValue));
    return raw === "" ? undefined : (JSON.parse(raw) as unknown);
  }
  return undefined;
}

/** Extracts the human-readable panic message of a `FunctionCallError`, when there is one. */
export function describeFailure(failure: unknown): string {
  if (typeof failure !== "object" || failure === null) return "The transaction failed.";
  const record = failure as Record<string, unknown>;
  const action = record["ActionError"];
  if (typeof action === "object" && action !== null) {
    const kind = (action as Record<string, unknown>)["kind"];
    if (typeof kind === "object" && kind !== null) {
      const fc = (kind as Record<string, unknown>)["FunctionCallError"];
      if (typeof fc === "object" && fc !== null) {
        const exec = (fc as Record<string, unknown>)["ExecutionError"];
        if (typeof exec === "string") return exec.replace(/^Smart contract panicked: /, "");
      }
      const first = Object.keys(kind)[0];
      if (first !== undefined) return first.replace(/([a-z])([A-Z])/g, "$1 $2");
    }
  }
  const invalid = record["InvalidTxError"];
  if (typeof invalid === "object" && invalid !== null) {
    const first = Object.keys(invalid)[0];
    if (first !== undefined) return first.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
  return "The transaction failed.";
}
