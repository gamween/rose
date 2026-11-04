/**
 * In-app Solana demo wallet on devnet: an ed25519 keypair generated in the browser, signing with
 * web3.js. Testnet only; exportable (as the 64-byte JSON array `solana-keygen` reads) and
 * forgettable from the wallet menu.
 */

import { Connection, Keypair, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { SOLANA_DEVNET_RPC_URL } from "@/lib/deployment";
import { DEMO_STORAGE_KEYS, readStored, removeStored, writeStored } from "./storage";

export type SolanaDemoWallet = { publicKey: string; secretKey: number[]; createdAt: number };

export function generateSolanaDemoWallet(): SolanaDemoWallet {
  const keypair = Keypair.generate();
  return { publicKey: keypair.publicKey.toBase58(), secretKey: [...keypair.secretKey], createdAt: Date.now() };
}

export function loadSolanaDemoWallet(): SolanaDemoWallet | null {
  const stored = readStored<SolanaDemoWallet>(DEMO_STORAGE_KEYS.solana);
  if (!stored || !Array.isArray(stored.secretKey) || stored.secretKey.length !== 64) return null;
  try {
    const keypair = Keypair.fromSecretKey(Uint8Array.from(stored.secretKey));
    return { ...stored, publicKey: keypair.publicKey.toBase58() };
  } catch {
    return null;
  }
}

export function saveSolanaDemoWallet(wallet: SolanaDemoWallet): void {
  writeStored(DEMO_STORAGE_KEYS.solana, wallet);
}

export function forgetSolanaDemoWallet(): void {
  removeStored(DEMO_STORAGE_KEYS.solana);
}

/** The `[u8; 64]` JSON array format of `solana-keygen`, so the key can be reused with the CLI. */
export function exportSolanaDemoWallet(wallet: SolanaDemoWallet): string {
  return JSON.stringify(wallet.secretKey);
}

export function solanaConnection(commitment: "confirmed" | "finalized" = "confirmed"): Connection {
  return new Connection(SOLANA_DEVNET_RPC_URL, commitment);
}

export function solanaDemoKeypair(wallet: SolanaDemoWallet): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(wallet.secretKey));
}

export function solanaDemoPublicKey(wallet: SolanaDemoWallet): PublicKey {
  return new PublicKey(wallet.publicKey);
}

/** Signs a legacy or versioned transaction with the demo keypair (the wallet-adapter `signTransaction` shape). */
export function signWithSolanaDemo<T extends Transaction | VersionedTransaction>(wallet: SolanaDemoWallet, transaction: T): T {
  const keypair = solanaDemoKeypair(wallet);
  if ("version" in transaction) transaction.sign([keypair]);
  else transaction.partialSign(keypair);
  return transaction;
}
