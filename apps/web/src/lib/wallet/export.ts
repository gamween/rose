/**
 * Export formats of the in-app demo keys ("Export demo key" in the wallet drawer). Plain JSON with
 * no wallet SDK, so the top bar can offer the export without loading the signing libraries.
 */

import { BASE_SEPOLIA_CHAIN_ID } from "@/lib/deployment";
import type { EvmDemoWallet } from "./evm-demo";
import type { NearDemoWallet } from "./near-demo";
import type { SolanaDemoWallet } from "./solana-demo";

/** JSON in the near-cli legacy keychain format, so the key can be reused with `near-cli-rs`. */
export function exportNearDemoWallet(wallet: NearDemoWallet): string {
  return JSON.stringify({ account_id: wallet.accountId, public_key: wallet.publicKey, private_key: wallet.secretKey, network: "testnet", label: "rose demo wallet" }, null, 2);
}

export function exportEvmDemoWallet(wallet: EvmDemoWallet): string {
  return JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey, chainId: BASE_SEPOLIA_CHAIN_ID, label: "rose demo wallet (Base Sepolia)" }, null, 2);
}

/** The `[u8; 64]` JSON array format of `solana-keygen`, so the key can be reused with the CLI. */
export function exportSolanaDemoWallet(wallet: SolanaDemoWallet): string {
  return JSON.stringify(wallet.secretKey);
}
