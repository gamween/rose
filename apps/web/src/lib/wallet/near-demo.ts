/**
 * In-app NEAR demo wallet: an ed25519 key generated in the browser, an account created on testnet
 * through `/api/faucet` (the NEAR faucet helper near-cli-rs uses), transactions signed and sent
 * directly with near-api-js 7. Testnet only; the key never leaves this browser unless exported.
 */

import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { NearRpc, NearRpcError, outcomeFailure, type FinalExecutionOutcome, type FunctionCall } from "@rose/sdk";
import { NEAR_READ_RPC_ENDPOINTS, NEAR_RPC_URL } from "@/lib/deployment";
import { failureToActionError, RoseActionError } from "@/lib/errors";
import { DEMO_STORAGE_KEYS, readStored, removeStored, writeStored } from "./storage";

export type NearDemoWallet = {
  accountId: string;
  publicKey: string;
  /** `ed25519:<base58 secret>` as near-api-js serializes it. */
  secretKey: KeyPairString;
  createdAt: number;
};

const ACCOUNT_SUFFIX = ".testnet";

/** A fresh, unused-looking account id: `rose-demo-<6 random chars>.testnet`. */
export function randomDemoAccountId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `rose-demo-${suffix}${ACCOUNT_SUFFIX}`;
}

export function generateNearDemoWallet(accountId = randomDemoAccountId()): NearDemoWallet {
  const keyPair = KeyPair.fromRandom("ed25519");
  return { accountId, publicKey: keyPair.getPublicKey().toString(), secretKey: keyPair.toString(), createdAt: Date.now() };
}

export function loadNearDemoWallet(): NearDemoWallet | null {
  const stored = readStored<NearDemoWallet>(DEMO_STORAGE_KEYS.near);
  if (!stored || typeof stored.accountId !== "string" || typeof stored.secretKey !== "string") return null;
  return stored;
}

export function saveNearDemoWallet(wallet: NearDemoWallet): void {
  writeStored(DEMO_STORAGE_KEYS.near, wallet);
}

export function forgetNearDemoWallet(): void {
  removeStored(DEMO_STORAGE_KEYS.near);
  removeStored(DEMO_STORAGE_KEYS.nearOnChain);
}

/**
 * Remembers that the demo account was seen on chain, so a later page load starts from that instead
 * of "unknown". Another account (an external wallet's) is not recorded: it would replace the demo
 * account's memory.
 */
export function rememberNearDemoOnChain(accountId: string): void {
  if (loadNearDemoWallet()?.accountId !== accountId) return;
  writeStored(DEMO_STORAGE_KEYS.nearOnChain, accountId);
}

/** Whether this browser already saw the demo account on chain (an account is never deleted by the app). */
export function nearDemoKnownOnChain(accountId: string): boolean {
  return readStored<string>(DEMO_STORAGE_KEYS.nearOnChain) === accountId;
}

export function nearProvider(): JsonRpcProvider {
  return new JsonRpcProvider({ url: NEAR_RPC_URL });
}

/** The read client of the demo wallet: the app's read endpoints in failover order (sends go through `nearProvider`). */
export function nearRpc(): NearRpc {
  return new NearRpc({ endpoints: NEAR_READ_RPC_ENDPOINTS });
}

export function nearDemoAccount(wallet: NearDemoWallet): Account {
  return new Account(wallet.accountId, nearProvider(), KeyPairSigner.fromSecretKey(wallet.secretKey));
}

/**
 * What the chain says about an account: `missing` only on the RPC's definite `UNKNOWN_ACCOUNT`
 * answer, `unknown` when no endpoint answered (rate limits, network failures), so a caller keeps
 * its last known value instead of mistaking a busy RPC for a missing account.
 */
export type NearAccountPresence = "exists" | "missing" | "unknown";

export type PresenceOptions = {
  rpc?: Pick<NearRpc, "viewAccount">;
  /** Rounds over the read endpoints before answering `unknown` (default 4). */
  attempts?: number;
  /** Wait before the second round, doubled before each later one (default 800 ms). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether the demo account exists on testnet (the faucet creates it asynchronously), retried with backoff across the read endpoints. */
export async function nearAccountPresence(accountId: string, { rpc = nearRpc(), attempts = 4, delayMs = 800, sleep = wait }: PresenceOptions = {}): Promise<NearAccountPresence> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs * 2 ** (attempt - 1));
    try {
      await rpc.viewAccount(accountId);
      return "exists";
    } catch (error) {
      if (error instanceof NearRpcError && error.kind === "account_missing") return "missing";
    }
  }
  return "unknown";
}

/**
 * Whether the demo key is an access key of its account id, so an existing account is this
 * wallet's own. The RPC answers a missing key with a result whose `error` says "does not exist";
 * any other failure throws a retryable error, never a guess (a wrong "no" would abandon the
 * account for a fresh id).
 */
export async function nearDemoKeyIsOnAccount(wallet: Pick<NearDemoWallet, "accountId" | "publicKey">, rpc: Pick<NearRpc, "viewAccessKey"> = nearRpc()): Promise<boolean> {
  let view: unknown;
  try {
    view = await rpc.viewAccessKey(wallet.accountId, wallet.publicKey);
  } catch (error) {
    if (error instanceof NearRpcError && error.kind === "account_missing") return false;
    throw new RoseActionError("rpc", "NEAR RPC busy", "Could not read the demo account's keys from NEAR testnet. Retry in a few seconds.", true);
  }
  const record = typeof view === "object" && view !== null ? (view as Record<string, unknown>) : {};
  if (typeof record["error"] === "string") {
    if (/does not exist/.test(record["error"])) return false;
    throw new RoseActionError("rpc", "NEAR RPC error", record["error"], true);
  }
  return "permission" in record;
}

/** The same key under a fresh account id, for when the generated id turns out to be taken by someone else. */
export function withFreshDemoAccountId(wallet: NearDemoWallet, accountId = randomDemoAccountId()): NearDemoWallet {
  return { ...wallet, accountId };
}

/** Signs and sends one function call with the demo key; throws a `RoseActionError` on failure. */
export async function sendNearDemoCall(wallet: NearDemoWallet, call: FunctionCall): Promise<FinalExecutionOutcome> {
  const account = nearDemoAccount(wallet);
  let outcome: FinalExecutionOutcome;
  try {
    outcome = (await account.signAndSendTransaction({
      receiverId: call.receiverId,
      actions: [actions.functionCall(call.methodName, call.args, call.gas, call.deposit)],
      waitUntil: "EXECUTED_OPTIMISTIC",
      throwOnFailure: false,
    })) as unknown as FinalExecutionOutcome;
  } catch (error) {
    throw error instanceof Error ? error : new RoseActionError("unknown", "Transaction failed", String(error));
  }
  const failure = outcomeFailure(outcome);
  if (failure !== null) {
    const described = failureToActionError(failure);
    throw new RoseActionError(described.kind, described.title, described.message, described.retryable);
  }
  return outcome;
}
