/**
 * NEAR testnet access for the scripts: views through the SDK's `NearRpc` (endpoint fallback and
 * rate-limit backoff), transactions signed with near-api-js 7. Keys come from the seed key file
 * or the near-cli legacy keychain and are never printed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, actions, baseEncode, JsonRpcProvider, KeyPairSigner, PublicKey, type Action, type KeyPairString } from "near-api-js";
import { InvalidNonceError } from "near-api-js/rpc-errors";
import {
  describeFailure,
  EngineViews,
  NearRpc,
  NearRpcError,
  outcomeLogs,
  outcomeValue,
  type FinalExecutionOutcome,
  type FunctionCall,
} from "@rose/sdk";
import { log, NEAR_CREDENTIALS_DIR, NEAR_RPC_ENDPOINTS, sleep } from "./env.ts";
import { txRef, type TxRef } from "./journal.ts";

export const ONE_NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;

export const rpc = new NearRpc({ endpoints: NEAR_RPC_ENDPOINTS, timeoutMs: 60_000 });
/** The same endpoints, the fallback first: a sent transaction is looked up on another provider than the one that took it. */
const lookupRpc = new NearRpc({ endpoints: [...NEAR_RPC_ENDPOINTS].reverse(), timeoutMs: 20_000 });

export function engineViews(engine: string): EngineViews {
  return new EngineViews(rpc, engine);
}

/** `amount` NEAR as yoctoNEAR, from a decimal string such as "0.35". */
export function near(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * ONE_NEAR + BigInt(fraction.padEnd(24, "0").slice(0, 24));
}

export function formatNear(yocto: bigint): string {
  return (Number(yocto / 10n ** 18n) / 1e6).toFixed(4);
}

/** Retries a view a few times when every endpoint is unreachable or rate limited. */
export async function withRetry<T>(what: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const transient = error instanceof NearRpcError && (error.kind === "unreachable" || error.kind === "http");
      if (!transient || attempt >= 6) throw error;
      log(`  ${what}: ${error.message}, retrying`);
      await sleep(3_000 * (attempt + 1));
    }
  }
}

export async function accountBalance(accountId: string): Promise<bigint | null> {
  try {
    const view = await withRetry(`view_account ${accountId}`, () => rpc.viewAccount(accountId));
    return BigInt(view.amount);
  } catch (error) {
    if (error instanceof NearRpcError && error.kind === "account_missing") return null;
    throw error;
  }
}

/** The result of a sent transaction. */
export interface NearResult {
  hash: string;
  outcome: FinalExecutionOutcome;
  gasTgas: number;
  value: unknown;
  /** The panic message when the transaction (or the promise it returned) failed. */
  failure: string | null;
  logs: string[];
}

export function nearRef(label: string, result: NearResult, extra: Partial<TxRef> = {}): TxRef {
  return txRef(label, "near", result.hash, { gasTgas: result.gasTgas, ...(result.failure === null ? {} : { failed: true, note: result.failure }), ...extra });
}

function gasOf(outcome: FinalExecutionOutcome): number {
  const burnt = [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((sum, entry) => sum + entry.outcome.gas_burnt, 0);
  return Math.round(burnt / 1e10) / 100;
}

/** The transaction's final status: a failure of the call or of the promise it returned. */
function finalFailure(outcome: FinalExecutionOutcome): string | null {
  return typeof outcome.status === "object" && "Failure" in outcome.status ? describeFailure(outcome.status.Failure) : null;
}

function resultOf(outcome: FinalExecutionOutcome): NearResult {
  const failure = finalFailure(outcome);
  return {
    hash: outcome.transaction.hash,
    outcome,
    gasTgas: gasOf(outcome),
    value: failure === null ? outcomeValue(outcome) : undefined,
    failure,
    logs: outcomeLogs(outcome),
  };
}

/** The final outcome of a transaction sent earlier (for example by a run that stopped before recording its result). */
export async function nearOutcome(hash: string, senderId: string): Promise<NearResult> {
  return resultOf(await withRetry(`tx ${hash}`, () => rpc.transactionStatus(hash, senderId, "FINAL")));
}

/** True for an RPC answer that rejected the request before it reached the chain (HTTP or JSON-RPC 429). */
function rateLimited(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as Error & { cause?: unknown }).cause === 429 || error.message.includes("-429") || error.message.includes("Rate limits exceeded");
}

/**
 * True for a non-JSON answer (an HTML error page of the public RPC's proxy) to one of the reads
 * near-api-js makes while building the transaction (access key nonce, recent block hash): nothing
 * was signed or sent yet.
 */
export function failedBeforeSigning(error: unknown): boolean {
  return error instanceof SyntaxError && (error.stack ?? "").includes("Account.createTransaction");
}

/**
 * Runs the building and signing of a transaction again when the RPC rate-limited one of its reads
 * or answered a non-JSON page. Nothing was sent yet, so a new attempt cannot duplicate anything.
 */
async function retryBeforeSending<T>(what: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(rateLimited(error) || failedBeforeSigning(error)) || attempt >= 8) throw error;
      log(`  ${what}: ${failedBeforeSigning(error) ? "the RPC answered a non-JSON page before signing" : "rate limited by the RPC"}, retrying in ${5 * (attempt + 1)} s`);
      await sleep(5_000 * (attempt + 1));
    }
  }
}

/**
 * True for a failed send after which the transaction may simply not have arrived: a rate limit
 * (FastNEAR answers 429 to some `send_tx` it forwarded, seen live), a non-JSON page from a proxy,
 * or a transport failure (connection reset, timeout).
 */
function resendable(error: unknown): boolean {
  if (rateLimited(error) || error instanceof SyntaxError || error instanceof TypeError) return true;
  return error instanceof Error && /fetch failed|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error.message);
}

/** How `sendOnce` reaches the network for one signed transaction. */
export interface OneTransaction {
  /** Sends the signed transaction and waits until it is final. */
  send: () => Promise<FinalExecutionOutcome>;
  /** Whether the network knows the transaction's hash; null when the lookup itself failed. */
  known: () => Promise<boolean | null>;
  /** The final outcome of a transaction the network knows. */
  final: () => Promise<FinalExecutionOutcome>;
  wait: (ms: number) => Promise<void>;
}

/**
 * The first send of a transaction was refused for its nonce (another transaction of the key used
 * it, or the cached nonce was stale) and the network does not know the transaction: its bytes
 * never executed, so signing it again with a fresh nonce cannot duplicate it.
 */
export class StaleNonceError extends Error {
  readonly refusal: InvalidNonceError;

  constructor(refusal: InvalidNonceError) {
    super(refusal.message);
    this.name = "StaleNonceError";
    this.refusal = refusal;
  }
}

/**
 * Sends one signed transaction without ever executing it twice. An RPC can fail a `send_tx` it
 * already forwarded (FastNEAR answered HTTP 429 to three that executed), so after any failed send
 * the transaction is looked up by its hash, known before sending, on the other endpoint: known, its
 * final outcome is returned; unknown after a rate limit or a transport failure, the same signed
 * bytes are sent again, which the nonce makes harmless; otherwise the error stands. A lookup that
 * fails is retried, and the send is never repeated while the network may know the transaction. A
 * first send refused for its nonce throws `StaleNonceError`, the one case the caller may sign again.
 */
export async function sendOnce(what: string, hash: string, transaction: OneTransaction): Promise<FinalExecutionOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transaction.send();
    } catch (error) {
      let known = await transaction.known();
      for (let lookup = 1; known === null && lookup <= 4; lookup += 1) {
        await transaction.wait(3_000 * lookup);
        known = await transaction.known();
      }
      if (known === true) {
        log(`  ${what}: the send failed (${error instanceof Error ? error.message : String(error)}) but the network has ${hash}; waiting for its final outcome`);
        return transaction.final();
      }
      if (known === false && attempt === 0 && error instanceof InvalidNonceError) throw new StaleNonceError(error);
      if (known === null || !resendable(error) || attempt >= 8) throw error;
      log(`  ${what}: the send failed (${error instanceof Error ? error.message : String(error)}) and the network does not know ${hash}; sending the same signed transaction again in ${5 * (attempt + 1)} s`);
      await transaction.wait(5_000 * (attempt + 1));
    }
  }
}

/** The `cause.name` of a JSON-RPC error answered by the NEAR RPC. */
function rpcCause(error: unknown): string | undefined {
  return error instanceof NearRpcError ? (error.data as { cause?: { name?: string } } | undefined)?.cause?.name : undefined;
}

/**
 * The final outcome of a transaction the network knows, through the primary endpoint first (dRPC's
 * free plan times out long `tx` waits). The node's own wait ends after about 10 s with
 * `TIMEOUT_ERROR` when finality takes longer (an MPC callback), so it asks again.
 */
async function finalOutcome(hash: string, senderId: string): Promise<FinalExecutionOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rpc.transactionStatus(hash, senderId, "FINAL");
    } catch (error) {
      const transient = error instanceof NearRpcError && (error.kind === "unreachable" || error.kind === "http" || rpcCause(error) === "TIMEOUT_ERROR" || /time(d)? ?out/i.test(error.message));
      if (!transient || attempt >= 20) throw error;
      log(`  tx ${hash}: not final yet (${error.message}), asking again`);
      await sleep(3_000);
    }
  }
}

/** Whether the network knows `hash` (`tx` with `wait_until` NONE answers `UNKNOWN_TRANSACTION` otherwise); null when it cannot tell. */
async function transactionKnown(hash: string, senderId: string): Promise<boolean | null> {
  try {
    await lookupRpc.transactionStatus(hash, senderId, "NONE");
    return true;
  } catch (error) {
    return rpcCause(error) === "UNKNOWN_TRANSACTION" ? false : null;
  }
}

/** A NEAR account that signs transactions. */
export class NearActor {
  readonly accountId: string;
  private account: Account;
  private readonly provider: JsonRpcProvider;
  private readonly signer: KeyPairSigner;

  constructor(accountId: string, secretKey: KeyPairString) {
    this.accountId = accountId;
    this.provider = new JsonRpcProvider({ url: NEAR_RPC_ENDPOINTS[0] ?? "" }, { retries: 6, wait: 2_000, backoff: 1.6 });
    this.signer = KeyPairSigner.fromSecretKey(secretKey);
    this.account = new Account(accountId, this.provider, this.signer);
  }

  /**
   * Signs one transaction and sends it until it is final, never executing it twice (`sendOnce`).
   * Signs again only on `StaleNonceError`, with a fresh `Account` whose nonce cache reads the key's
   * nonce from the chain again (near-api-js's own recovery, which this replaces).
   */
  private async execute(what: string, receiverId: string, transactionActions: Action[]): Promise<FinalExecutionOutcome> {
    for (let resign = 0; ; resign += 1) {
      const signed = await retryBeforeSending(what, async () => {
        const transaction = await this.account.createTransaction({ receiverId, actions: transactionActions, publicKey: await this.signer.getPublicKey() });
        return this.signer.signTransaction(transaction);
      });
      const hash = baseEncode(signed.txHash);
      try {
        return await sendOnce(what, hash, {
          send: async () => (await this.provider.sendTransactionUntil(signed.signedTransaction, "FINAL")) as unknown as FinalExecutionOutcome,
          known: () => transactionKnown(hash, this.accountId),
          final: () => finalOutcome(hash, this.accountId),
          wait: sleep,
        });
      } catch (error) {
        if (!(error instanceof StaleNonceError)) throw error;
        if (resign >= 5) throw error.refusal;
        log(`  ${what}: the nonce of ${hash} was already used; signing again with a fresh nonce`);
        this.account = new Account(this.accountId, this.provider, this.signer);
      }
    }
  }

  /**
   * Sends one function call and waits for finality, so the `final` views read right after it see
   * its effects (callbacks of MPC requests included). Throws on failure unless `allowFailure`
   * (the failure is then in the result).
   */
  async call(fc: FunctionCall, options: { allowFailure?: boolean } = {}): Promise<NearResult> {
    const result = resultOf(await this.execute(`${fc.receiverId}.${fc.methodName}`, fc.receiverId, [actions.functionCall(fc.methodName, fc.args, fc.gas, fc.deposit)]));
    if (result.failure !== null && options.allowFailure !== true) {
      throw new Error(`${this.accountId} -> ${fc.receiverId}.${fc.methodName} failed: ${result.failure} (${result.hash})`);
    }
    return result;
  }

  async transfer(receiverId: string, amount: bigint): Promise<string> {
    return (await this.execute(`transfer to ${receiverId}`, receiverId, [actions.transfer(amount)])).transaction.hash;
  }

  /** Creates `newAccountId`, a sub-account of this account, with a full-access key and `amount`. */
  async createSubAccount(newAccountId: string, publicKey: string, amount: bigint): Promise<string> {
    if (!newAccountId.endsWith(`.${this.accountId}`)) throw new Error(`${newAccountId} is not a sub-account of ${this.accountId}`);
    const outcome = await this.execute(`create ${newAccountId}`, newAccountId, [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(PublicKey.from(publicKey))]);
    const failure = finalFailure(outcome);
    if (failure !== null) throw new Error(`creating ${newAccountId} failed: ${failure}`);
    return outcome.transaction.hash;
  }
}

/** An account of the near-cli legacy keychain (`~/.near-credentials/testnet/<account>.json`). */
export function keychainActor(accountId: string): NearActor {
  const file = JSON.parse(readFileSync(join(NEAR_CREDENTIALS_DIR, `${accountId}.json`), "utf8")) as { private_key?: string };
  if (file.private_key === undefined) throw new Error(`no private_key for ${accountId} in the legacy keychain`);
  return new NearActor(accountId, file.private_key as KeyPairString);
}
