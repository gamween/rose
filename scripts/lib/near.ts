/**
 * NEAR testnet access for the scripts: views through the SDK's `NearRpc` (endpoint fallback and
 * rate-limit backoff), transactions signed with near-api-js 7. Keys come from the seed key file
 * or the near-cli legacy keychain and are never printed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, actions, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
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
 * Runs a signing call again when the RPC rate-limited it or failed while the transaction was being
 * built. Neither request reached the chain, so a new attempt (with a fresh nonce) cannot duplicate
 * a transaction.
 */
async function retryRateLimited<T>(what: string, run: () => Promise<T>): Promise<T> {
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

/** A NEAR account that signs transactions. */
export class NearActor {
  readonly accountId: string;
  private readonly account: Account;

  constructor(accountId: string, secretKey: KeyPairString) {
    this.accountId = accountId;
    const provider = new JsonRpcProvider({ url: NEAR_RPC_ENDPOINTS[0] ?? "" }, { retries: 6, wait: 2_000, backoff: 1.6 });
    this.account = new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey));
  }

  /**
   * Sends one function call and waits for finality, so the `final` views read right after it see
   * its effects (callbacks of MPC requests included). Throws on failure unless `allowFailure`
   * (the failure is then in the result).
   */
  async call(fc: FunctionCall, options: { allowFailure?: boolean } = {}): Promise<NearResult> {
    const response = await retryRateLimited(`${fc.receiverId}.${fc.methodName}`, () =>
      this.account.signAndSendTransaction({
        receiverId: fc.receiverId,
        actions: [actions.functionCall(fc.methodName, fc.args, fc.gas, fc.deposit)],
        waitUntil: "FINAL",
        throwOnFailure: false,
      }),
    );
    const result = resultOf(response as unknown as FinalExecutionOutcome);
    if (result.failure !== null && options.allowFailure !== true) {
      throw new Error(`${this.accountId} -> ${fc.receiverId}.${fc.methodName} failed: ${result.failure} (${result.hash})`);
    }
    return result;
  }

  async transfer(receiverId: string, amount: bigint): Promise<string> {
    const response = await retryRateLimited(`transfer to ${receiverId}`, () => this.account.transfer({ receiverId, amount }));
    return (response as unknown as FinalExecutionOutcome).transaction.hash;
  }

  async createSubAccount(newAccountId: string, publicKey: string, amount: bigint): Promise<string> {
    const response = await retryRateLimited(`create ${newAccountId}`, () => this.account.createAccount({ newAccountId, publicKey, nearToTransfer: amount }));
    const outcome = response as unknown as FinalExecutionOutcome;
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
