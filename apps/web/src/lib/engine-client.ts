/**
 * One place to reach the deployed engine from the app pages: typed views and change-call
 * builders of `@rose/sdk` bound to `NEXT_PUBLIC_ENGINE_ACCOUNT`, plus the MPC contract's
 * `derived_public_key` view (the Solana deposit addresses of spec 7.2 are derived there).
 */

import { EngineCalls, EngineViews, NearRpc, NearRpcError } from "@rose/sdk";
import { deployed, MPC_ACCOUNT, NEAR_RPC_FALLBACK_URL, NEAR_RPC_URL } from "./deployment";

/** Thrown by page fetchers when the engine (or another address they need) is not deployed yet. */
export class EngineNotDeployedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "EngineNotDeployedError";
  }
}

const NOT_DEPLOYED_RPC_KINDS = new Set(["account_missing", "no_contract", "method_missing"]);

/** Whether `error` means "not deployed yet" rather than a failure. */
export function isNotDeployedError(error: unknown): boolean {
  return error instanceof EngineNotDeployedError || (error instanceof NearRpcError && NOT_DEPLOYED_RPC_KINDS.has(error.kind));
}

let rpc: NearRpc | null = null;

/** The shared NEAR RPC client (FastNEAR with the official testnet RPC as fallback). */
export function nearRpc(): NearRpc {
  rpc ??= new NearRpc({ endpoints: [NEAR_RPC_URL, NEAR_RPC_FALLBACK_URL] });
  return rpc;
}

export type EngineClient = { account: string; views: EngineViews; calls: EngineCalls };

/** The engine bindings, or null while `NEXT_PUBLIC_ENGINE_ACCOUNT` is unset. */
export function engineClient(): EngineClient | null {
  const account = deployed("engineAccount");
  if (!account) return null;
  return { account, views: new EngineViews(nearRpc(), account), calls: new EngineCalls(account) };
}

/** The engine bindings; throws `EngineNotDeployedError` while the engine is not deployed. */
export function requireEngine(): EngineClient {
  const client = engineClient();
  if (!client) throw new EngineNotDeployedError("The engine is not deployed yet (NEXT_PUBLIC_ENGINE_ACCOUNT is unset).");
  return client;
}

/**
 * `derived_public_key` of the MPC contract (`v1.signer-prod.testnet`, tag 3.18.0,
 * `crates/contract/src/api/keys.rs`): `{ path, predecessor, domain_id }` returns
 * `"ed25519:<base58>"` or `"secp256k1:<base58>"`.
 */
export async function mpcDerivedPublicKey(path: string, predecessor: string, domainId: number, signal?: AbortSignal): Promise<string> {
  const { value } = await nearRpc().viewFunction<string>(MPC_ACCOUNT, "derived_public_key", { path, predecessor, domain_id: domainId }, signal);
  return value;
}

/** The base58 key of an `ed25519:<base58>` string, as a Solana address. */
export function ed25519KeyToSolanaAddress(key: string): string {
  if (!key.startsWith("ed25519:")) throw new Error(`Expected an ed25519 key, got ${key.slice(0, 12)}…`);
  return key.slice("ed25519:".length);
}
