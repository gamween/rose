/**
 * In-app EVM demo wallet on Base Sepolia: a private key generated in the browser and used
 * through a viem wallet client. Testnet only; exportable and forgettable from the wallet menu.
 */

import { baseSepoliaChain, createBaseClient, type SignerClient } from "@rose/sdk";
import { createWalletClient, http, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { BASE_SEPOLIA_RPC_URL } from "@/lib/deployment";
import { DEMO_STORAGE_KEYS, readStored, removeStored, writeStored } from "./storage";

export type EvmDemoWallet = { address: `0x${string}`; privateKey: Hex; createdAt: number };

export function generateEvmDemoWallet(): EvmDemoWallet {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey, createdAt: Date.now() };
}

export function loadEvmDemoWallet(): EvmDemoWallet | null {
  const stored = readStored<EvmDemoWallet>(DEMO_STORAGE_KEYS.evm);
  if (!stored || typeof stored.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(stored.privateKey)) return null;
  return { ...stored, address: privateKeyToAccount(stored.privateKey).address };
}

export function saveEvmDemoWallet(wallet: EvmDemoWallet): void {
  writeStored(DEMO_STORAGE_KEYS.evm, wallet);
}

export function forgetEvmDemoWallet(): void {
  removeStored(DEMO_STORAGE_KEYS.evm);
}

export function exportEvmDemoWallet(wallet: EvmDemoWallet): string {
  return JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey, chainId: baseSepoliaChain.id, label: "rose demo wallet (Base Sepolia)" }, null, 2);
}

export function basePublicClient(): PublicClient {
  return createBaseClient({ rpcUrl: BASE_SEPOLIA_RPC_URL });
}

export function evmDemoAccount(wallet: EvmDemoWallet): PrivateKeyAccount {
  return privateKeyToAccount(wallet.privateKey);
}

/** A viem wallet client that signs locally with the demo key and broadcasts to Base Sepolia. */
export function evmDemoWalletClient(wallet: EvmDemoWallet): SignerClient {
  return createWalletClient({ account: evmDemoAccount(wallet), chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC_URL) });
}
