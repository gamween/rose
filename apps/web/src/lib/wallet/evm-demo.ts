/**
 * In-app EVM demo wallet on Base Sepolia: a private key generated in the browser and used
 * through a viem wallet client. Testnet only; exportable and forgettable from the wallet menu.
 */

import { baseSepoliaChain, createBaseClient, type SignerClient } from "@rose/sdk";
import { createWalletClient, http, MethodNotSupportedRpcError, type Hex, type PublicClient, type Transport } from "viem";
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

export function basePublicClient(): PublicClient {
  return createBaseClient({ rpcUrl: BASE_SEPOLIA_RPC_URL });
}

export function evmDemoAccount(wallet: EvmDemoWallet): PrivateKeyAccount {
  return privateKeyToAccount(wallet.privateKey);
}

/**
 * The public Base Sepolia endpoint answers `eth_fillTransaction` (tried first by viem when it
 * prepares a transaction) with HTTP 401, which the browser logs as a console error before viem
 * falls back to the individual calls. The demo wallet refuses that one method locally instead,
 * so viem goes straight to the fallback.
 */
export function baseSepoliaWalletTransport(): Transport {
  const inner = http(BASE_SEPOLIA_RPC_URL);
  return (params) => {
    const transport = inner(params);
    return {
      ...transport,
      request: (async (args, options) => {
        if (args.method === "eth_fillTransaction") throw new MethodNotSupportedRpcError(new Error("eth_fillTransaction is not available on the public Base Sepolia endpoint"));
        return transport.request(args, options);
      }) as typeof transport.request,
    };
  };
}

/** A viem wallet client that signs locally with the demo key and broadcasts to Base Sepolia. */
export function evmDemoWalletClient(wallet: EvmDemoWallet): SignerClient {
  return createWalletClient({ account: evmDemoAccount(wallet), chain: baseSepoliaChain, transport: baseSepoliaWalletTransport() });
}
