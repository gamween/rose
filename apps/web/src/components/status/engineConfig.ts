import { viewCall, type ViewOptions } from "@/lib/engine";

/** JSON shape of the engine `get_config` view (`Config` in `contracts/engine/src/types.rs`). */
export type EngineConfig = {
  mpc_account: string;
  sign_secp256k1_domain: number;
  sign_ed25519_domain: number;
  ckd_domain: number;
  foreign_tx_domain: number;
  ckd_public_key: string;
  fee_recipient: string;
  near_cash_token: string;
  base_cash_tokens: string[];
  rose_vault: string;
  sablier_lockup: string;
  streamflow_program: string;
  default_key_timeout: string;
  default_reveal_window: string;
  derived_addresses: { vault_base: string; vault_sol: string; gas_sol: string } | null;
};

function isConfig(value: unknown): value is EngineConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.mpc_account === "string" &&
    typeof config.rose_vault === "string" &&
    typeof config.near_cash_token === "string" &&
    Array.isArray(config.base_cash_tokens) &&
    ("derived_addresses" in config ? config.derived_addresses === null || typeof config.derived_addresses === "object" : true)
  );
}

export async function fetchEngineConfig(account: string, options: ViewOptions = {}): Promise<{ config: EngineConfig; blockHeight: number }> {
  const { value, blockHeight } = await viewCall<unknown>(account, "get_config", {}, options);
  if (!isConfig(value)) throw new Error("get_config returned an unexpected shape.");
  return { config: { ...value, derived_addresses: value.derived_addresses ?? null }, blockHeight };
}
