/**
 * Helpers of `verify.ts` that need nothing installed: a JSON-RPC client with endpoint failover,
 * the decoding of an `address` returned by `eth_call`, and where `@rose/sdk` modules load from
 * without a build.
 */

import { setTimeout as sleep } from "node:timers/promises";

/** Milliseconds before one request is abandoned. */
const REQUEST_TIMEOUT_MS = 8_000;
/** Passes over the endpoint list before a call fails, with a pause between two passes. */
const PASSES = 2;
const PASS_PAUSE_MS = 1_500;

export interface RpcError { code?: number; message?: string; data?: unknown; cause?: { name?: string } }

interface Envelope { id?: unknown; result?: unknown; error?: RpcError }

/**
 * True for a JSON-RPC error worth asking again after a pause (rate limit, deprecated or unsynced
 * node, timeout) rather than an answer to the request. `rpc.testnet.near.org` refuses with -429
 * "THIS ENDPOINT IS DEPRECATED" (docs/verification.md).
 */
export function isTransientRpcError(error: RpcError | undefined): boolean {
  if (error === undefined) return false;
  if (error.code === -429 || error.code === 429 || error.code === -32005) return true;
  const text = `${error.cause?.name ?? ""} ${error.message ?? ""} ${typeof error.data === "string" ? error.data : ""}`;
  return /TOO_MANY_REQUESTS|TIMEOUT_ERROR|NO_SYNCED_BLOCKS|NOT_SYNCED|INTERNAL_ERROR|rate limit|too many requests|deprecated/i.test(text);
}

function describe(error: RpcError): string {
  const data = typeof error.data === "string" ? error.data : JSON.stringify(error.data ?? error.cause ?? null);
  return `${error.message ?? "error"} ${data}`.trim();
}

function envelopes(json: unknown): Envelope[] {
  const list: unknown[] = Array.isArray(json) ? json : [json];
  return list.map((entry) => (typeof entry === "object" && entry !== null ? (entry as Envelope) : {}));
}

/** A JSON-RPC answer that carries an error, or no result, instead of the result asked for. */
class RpcAnswerError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "RpcAnswerError";
    this.transient = transient;
  }
}

function resultOf(envelope: Envelope | undefined, host: string): unknown {
  if (envelope?.error !== undefined) throw new RpcAnswerError(`${host} answered with an error: ${describe(envelope.error)}`, isTransientRpcError(envelope.error));
  if (envelope?.result === undefined) throw new RpcAnswerError(`${host} answered without a result`, true);
  return envelope.result;
}

export interface RpcOptions {
  fetch?: typeof globalThis.fetch;
  pauseMs?: number;
}

/**
 * JSON-RPC over `fetch`. A request goes to the endpoint that answered last, and moves to the next
 * one on a network error, a timeout, an HTTP error, a body that is not JSON, or an answer that
 * carries an error or no result. An error answer is final once every endpoint has given one in the
 * same pass; a rate limit or a transport failure gets a second pass after a pause. Once a call
 * found no endpoint answering, later calls fail at once, so an outage costs one call's retries,
 * not one per check.
 */
export class JsonRpc {
  readonly chain: string;
  readonly endpoints: readonly string[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly pauseMs: number;
  private preferred = 0;
  private down: Error | null = null;

  constructor(chain: string, endpoints: readonly string[], options: RpcOptions = {}) {
    if (endpoints.length === 0) throw new Error(`no ${chain} RPC endpoint`);
    this.chain = chain;
    this.endpoints = endpoints;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.pauseMs = options.pauseMs ?? PASS_PAUSE_MS;
  }

  /** One call; resolves with its result and the host that answered. */
  call(method: string, params: unknown): Promise<{ result: unknown; host: string }> {
    return this.post({ jsonrpc: "2.0", id: 0, method, params }, (json, host) => ({ result: resultOf(envelopes(json)[0], host), host }));
  }

  /** Several calls in one JSON-RPC batch, so one endpoint answers all of them. */
  batch(calls: readonly { method: string; params: unknown }[]): Promise<{ results: unknown[]; host: string }> {
    return this.post(
      calls.map(({ method, params }, id) => ({ jsonrpc: "2.0", id, method, params })),
      (json, host) => {
        if (!Array.isArray(json)) throw new RpcAnswerError(`${host} did not answer the batch with a list`, true);
        const answers = envelopes(json);
        return { results: calls.map((_, id) => resultOf(answers.find((answer) => answer.id === id), host)), host };
      },
    );
  }

  /** Sends `body` to the endpoints in turn until `read` accepts an answer (see the class comment). */
  private async post<T>(body: unknown, read: (json: unknown, host: string) => T): Promise<T> {
    if (this.down !== null) throw this.down;
    const failures: string[] = [];
    const refusals: RpcAnswerError[] = [];
    for (let pass = 0; pass < PASSES; pass += 1) {
      if (pass > 0) await sleep(this.pauseMs);
      const refusedBefore = refusals.length;
      for (let step = 0; step < this.endpoints.length; step += 1) {
        const index = (this.preferred + step) % this.endpoints.length;
        const endpoint = this.endpoints[index] ?? "";
        const host = URL.canParse(endpoint) ? new URL(endpoint).host : endpoint;
        try {
          const response = await this.fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!response.ok) {
            failures.push(`${host}: HTTP ${response.status}`);
            continue;
          }
          const answer = read(await response.json(), host);
          this.preferred = index;
          return answer;
        } catch (error) {
          if (error instanceof RpcAnswerError && !error.transient) refusals.push(error);
          failures.push(error instanceof RpcAnswerError ? error.message : `${host}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const refusal = refusals[refusedBefore];
      if (refusal !== undefined && refusals.length - refusedBefore === this.endpoints.length) throw refusal;
    }
    const [refusal] = refusals;
    if (refusal !== undefined) throw refusal;
    this.down = new Error(`no ${this.chain} RPC endpoint answered (${failures.join("; ")})`);
    throw this.down;
  }
}

/** The `address` an `eth_call` returned: exactly one 32-byte word whose first 12 bytes are zero. */
export function abiAddress(data: unknown): string {
  if (typeof data !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(data)) throw new Error(`not one ABI-encoded address: ${JSON.stringify(data)}`);
  return `0x${data.slice(26).toLowerCase()}`;
}

/**
 * Where an `@rose/sdk` module loads from when nothing is built: `@rose/sdk/<entry>` (the package's
 * `clearing`, `math` and `unlock` entry points) maps to the source its `exports` name as the
 * types, `src/<entry>.ts`, and a relative `./x.js` import inside those sources (the layout tsc
 * emits) to the `./x.ts` beside it. Null for any other specifier, which resolves as usual.
 */
export function sdkSource(specifier: string, parentUrl: string | undefined, sources: URL): string | null {
  const entry = /^@rose\/sdk\/(\w+)$/.exec(specifier)?.[1];
  if (entry !== undefined) return new URL(`${entry}.ts`, sources).href;
  if (parentUrl?.startsWith(sources.href) === true && /^\.\.?\/.+\.js$/.test(specifier)) return `${specifier.slice(0, -3)}.ts`;
  return null;
}
