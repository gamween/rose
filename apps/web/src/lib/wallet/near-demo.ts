/**
 * In-app NEAR demo wallet: an ed25519 key generated in the browser, an account created on testnet
 * through `/api/faucet` (the NEAR faucet helper near-cli-rs uses), transactions signed and sent
 * directly with near-api-js 7. Testnet only; the key never leaves this browser unless exported.
 */

import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { NearRpc, outcomeFailure, type FinalExecutionOutcome, type FunctionCall } from "@rose/sdk";
import { NEAR_RPC_FALLBACK_URL, NEAR_RPC_URL } from "@/lib/deployment";
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
}

export function nearProvider(): JsonRpcProvider {
  return new JsonRpcProvider({ url: NEAR_RPC_URL });
}

export function nearRpc(): NearRpc {
  return new NearRpc({ endpoints: [NEAR_RPC_URL, NEAR_RPC_FALLBACK_URL] });
}

export function nearDemoAccount(wallet: NearDemoWallet): Account {
  return new Account(wallet.accountId, nearProvider(), KeyPairSigner.fromSecretKey(wallet.secretKey));
}

/** Whether the demo account exists on testnet yet (the faucet creates it asynchronously). */
export async function nearAccountExists(accountId: string): Promise<boolean> {
  try {
    await nearRpc().viewAccount(accountId);
    return true;
  } catch {
    return false;
  }
}

/** Whether the demo key is an access key of its account id, so an existing account is this wallet's own. */
export async function nearDemoKeyIsOnAccount(wallet: Pick<NearDemoWallet, "accountId" | "publicKey">, rpc: Pick<NearRpc, "viewAccessKey"> = nearRpc()): Promise<boolean> {
  try {
    await rpc.viewAccessKey(wallet.accountId, wallet.publicKey);
    return true;
  } catch {
    return false;
  }
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
