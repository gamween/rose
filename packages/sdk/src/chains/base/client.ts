import { createPublicClient, defineChain, http, type Address, type Chain, type PublicClient } from "viem";

/** Base Sepolia chain id (verified live with `cast chain-id`, see docs/verification.md). */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Default public Base Sepolia RPC. */
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";

/**
 * Base Sepolia without the OP-stack formatters of viem's `baseSepolia` (rose reads logs, blocks and
 * receipts only, so plain chain types keep every helper on the generic `PublicClient`). Multicall3
 * at the canonical address, as in viem's definition.
 */
export const baseSepoliaChain: Chain = defineChain({
  id: BASE_SEPOLIA_CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [BASE_SEPOLIA_RPC] } },
  blockExplorers: { default: { name: "Basescan", url: "https://sepolia.basescan.org" } },
  contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11", blockCreated: 1_059_647 } },
  testnet: true,
});

/** Sablier Lockup v4.0.1 on Base Sepolia (deployed at block 38,985,887; see docs/verification.md). */
export const SABLIER_LOCKUP_V4: Address = "0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e";

/** Circle's USDC on Base Sepolia, accepted as a cash token when a user already holds it. */
export const CIRCLE_USDC_BASE_SEPOLIA: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Base Sepolia explorer link for a transaction. */
export function baseTxUrl(hash: string): string {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

/** Base Sepolia explorer link for an address. */
export function baseAddressUrl(address: string): string {
  return `https://sepolia.basescan.org/address/${address}`;
}

export interface BaseClientOptions {
  rpcUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** A viem public client on Base Sepolia with multicall batching enabled. */
export function createBaseClient(options: BaseClientOptions = {}): PublicClient {
  const fetchFn = options.fetch;
  return createPublicClient({
    chain: baseSepoliaChain,
    batch: { multicall: true },
    transport: http(options.rpcUrl ?? BASE_SEPOLIA_RPC, fetchFn ? { fetchFn } : {}),
  });
}
