/**
 * Minimal NEAR JSON-RPC client over `fetch` with endpoint fallback. The web app reads the engine
 * through it (no indexer) and the demo wallets send transactions through it.
 *
 * @module
 */

import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from "../encoding.js";

/** FastNEAR testnet RPC, the primary endpoint (spec section 6). */
export const NEAR_TESTNET_RPC = "https://test.rpc.fastnear.com";
/**
 * dRPC's public testnet RPC, used when FastNEAR is unreachable or rate limits the caller. Another
 * provider on purpose: FastNEAR's second host (`rpc.testnet.fastnear.com`) shares the primary's
 * per-IP limit, and `rpc.testnet.near.org` is deprecated: on 14 November 2026 it refused requests
 * with error -429 "THIS ENDPOINT IS DEPRECATED" while other clients shared the IP, and answered
 * 10 sequential ones about 3 s each later that day (both measured, docs/verification.md). Its free
 * plan times out long `tx` waits, so a `send_tx` through it can fail after the transaction was
 * accepted; the transaction still lands.
 */
export const NEAR_TESTNET_RPC_FALLBACK = "https://near-testnet.drpc.org";

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


/** Requests in flight at once across every `NearRpc` of this page (public RPCs rate limit bursts per IP). */
export const MAX_CONCURRENT_RPC_REQUESTS = 4;

let active = 0;
const waiting: (() => void)[] = [];

/**
 * Runs `task` once fewer than `MAX_CONCURRENT_RPC_REQUESTS` requests are in flight. A page that
 * mounts a dozen views at once otherwise fires them in one burst.
 */
export async function withRpcSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_RPC_REQUESTS) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/**
 * Request budget of one RPC endpoint. FastNEAR answers about 30 requests per IP and then HTTP 429
 * for several seconds (measured 2026-11-04: 30 of 60 parallel requests refused, 17 of 50 at 5 per
 * second; rpc.testnet.near.org refused 33 of 60 the same way), and its 429 carries no CORS header,
 * so the browser logs a blocked request. The budget keeps a page under that line.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const at = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((at - this.last) / 1000) * this.refillPerSecond);
    this.last = at;
  }

  /** Milliseconds until a token is available (0 when one is available now). */
  waitMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  /** Takes a token, waiting for it when the budget is spent. */
  async take(): Promise<void> {
    for (let wait = this.waitMs(); wait > 0; wait = this.waitMs()) await new Promise((resolve) => setTimeout(resolve, wait));
    this.tokens -= 1;
  }
}

/** 20 requests at once, then 2.5 per second per endpoint: below the measured public limits. */
export const RPC_BUCKET_CAPACITY = 20;
export const RPC_REFILL_PER_SECOND = 2.5;

const buckets = new Map<string, TokenBucket>();

/**
 * The budget of a public endpoint whose limits were measured: FastNEAR, and rpc.testnet.near.org
 * for a caller that still lists it. dRPC, the default fallback, has none on purpose: it answered 80
 * of 80 requests sent 20 at a time without a 429 (docs/verification.md), and it takes the reads
 * FastNEAR refused, which a budget sized for FastNEAR would only delay. Other endpoints (private
 * RPCs, tests) have none either.
 */
function bucketOf(endpoint: string): TokenBucket | null {
  if (!/^https:\/\/(test\.rpc\.fastnear\.com|rpc\.testnet\.near\.org)\/?$/.test(endpoint)) return null;
  let bucket = buckets.get(endpoint);
  if (!bucket) {
    bucket = new TokenBucket(RPC_BUCKET_CAPACITY, RPC_REFILL_PER_SECOND);
    buckets.set(endpoint, bucket);
  }
  return bucket;
}

/**
 * How long an endpoint is passed over after it refused a request (429, 5xx, a non-JSON page) or
 * could not be reached. A browser cannot read a 429 sent without CORS headers, so it cannot honour
 * `retry-after`; without this pause every later request of the page would hit the limited
 * endpoint first and fail once more before falling over. An answer ends the pause early only when
 * its request left after the refusal: a provider that limits part of a burst still answers the
 * requests it let through, and those must not reopen it.
 */
export const RPC_COOLDOWN_MS = 10_000;

/** Per cooling endpoint: when it may be tried first again, and the number of the last request sent before it refused. */
const cooldowns = new Map<string, { until: number; lastSent: number }>();

/** Requests sent so far, numbered in the order they leave (see `RPC_COOLDOWN_MS`). */
let sentRequests = 0;

/** Milliseconds before `endpoint` is tried first again (0 when it is not cooling down). */
export function cooldownMs(endpoint: string, now: number = Date.now()): number {
  const cooldown = cooldowns.get(endpoint);
  return cooldown === undefined ? 0 : Math.max(0, cooldown.until - now);
}

function coolDown(endpoint: string): void {
  cooldowns.set(endpoint, { until: Date.now() + RPC_COOLDOWN_MS, lastSent: sentRequests });
}

/** Ends the pause of `endpoint` on an answer to request number `sent`, unless that request left before the refusal. */
function warmUp(endpoint: string, sent: number): void {
  const cooldown = cooldowns.get(endpoint);
  if (cooldown !== undefined && sent > cooldown.lastSent) cooldowns.delete(endpoint);
}

/** The endpoints in failover order, starting with the first one that has budget left now and is not cooling down. */
export function endpointOrder(endpoints: readonly string[], waitMs: (endpoint: string) => number = (endpoint) => Math.max(bucketOf(endpoint)?.waitMs() ?? 0, cooldownMs(endpoint))): string[] {
  const ready = endpoints.find((endpoint) => waitMs(endpoint) === 0);
  return ready === undefined ? [...endpoints] : [ready, ...endpoints.filter((endpoint) => endpoint !== ready)];
}

function isRetriable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Requests in flight, by endpoints, method and params (see `NearRpc.request`). */
const inFlight = new Map<string, Promise<unknown>>();

/** JSON-RPC client for NEAR testnet with endpoint fallback, a per-endpoint request budget and typed errors. */
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

  /**
   * Sends one JSON-RPC request, falling over to the next endpoint on network or server failures.
   * Identical requests in flight share one round trip (several components of a page read the
   * same view at mount); each caller's `signal` still aborts its own wait.
   */
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const key = method === "send_tx" ? null : `${this.endpoints.join(",")}|${method}|${JSON.stringify(params)}`;
    let shared = key === null ? undefined : inFlight.get(key);
    if (!shared) {
      shared = this.send(method, params);
      if (key !== null) {
        inFlight.set(key, shared);
        const forget = () => {
          inFlight.delete(key);
        };
        shared.then(forget, forget);
      }
    }
    if (!signal) return shared as Promise<T>;
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      (shared as Promise<T>).then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async send(method: string, params: unknown): Promise<unknown> {
    let lastError: NearRpcError | null = null;
    /* A transaction goes to the endpoints in the order given, whatever their pause or budget: the first is the one that holds its wait. */
    const order = method === "send_tx" ? [...this.endpoints] : endpointOrder(this.endpoints);
    for (const endpoint of order) {
      await bucketOf(endpoint)?.take();
      let sent = 0;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, this.timeoutMs);
      try {
        let response: Response;
        try {
          response = await withRpcSlot(() => {
            sentRequests += 1;
            sent = sentRequests;
            return this.fetchImpl(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: "rose", method, params }),
              signal: controller.signal,
            });
          });
        } catch (error) {
          lastError = new NearRpcError("unreachable", `${endpoint} could not be reached.`, error);
          coolDown(endpoint);
          continue;
        }
        if (!response.ok) {
          lastError = new NearRpcError("http", `${endpoint} answered with HTTP ${String(response.status)}.`);
          if (isRetriable(response.status)) {
            coolDown(endpoint);
            continue;
          }
          throw lastError;
        }
        let body: RpcEnvelope;
        try {
          body = (await response.json()) as RpcEnvelope;
        } catch {
          lastError = new NearRpcError("invalid_response", `${endpoint} returned a non-JSON body.`);
          coolDown(endpoint);
          continue;
        }
        warmUp(endpoint, sent);
        if (body.error) throw NearRpc.toError(body.error);
        if (body.result === undefined) throw new NearRpcError("invalid_response", "The RPC returned no result.");
        return body.result;
      } finally {
        clearTimeout(timer);
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
