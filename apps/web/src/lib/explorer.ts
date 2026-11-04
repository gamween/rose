/**
 * Explorer links per chain (spec section 6). NEAR: testnet.near.rocks is the primary explorer
 * (NearBlocks testnet is frozen and explorer.testnet.near.org is only a selector page), with
 * nearvalidate.org as the fallback shown next to it.
 */

import type { ExplorerLink } from "@/components/ui/Toast";

export type ChainId = "near" | "base" | "solana";

export const CHAIN_LABEL: Record<ChainId, string> = { near: "NEAR testnet", base: "Base Sepolia", solana: "Solana devnet" };

export function nearTxUrl(hash: string): string {
  return `https://testnet.near.rocks/tx/${hash}`;
}

export function nearTxFallbackUrl(hash: string): string {
  return `https://nearvalidate.org/txns/${hash}?network=testnet`;
}

export function nearAccountUrl(accountId: string): string {
  return `https://testnet.near.rocks/address/${accountId}`;
}

export function baseTxUrl(hash: string): string {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

export function baseAddressUrl(address: string): string {
  return `https://sepolia.basescan.org/address/${address}`;
}

export function solanaTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function solanaAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

/** Toast links for a transaction on `chain`. */
export function txLinks(chain: ChainId, hash: string): ExplorerLink[] {
  switch (chain) {
    case "near":
      return [
        { href: nearTxUrl(hash), label: "View on near.rocks" },
        { href: nearTxFallbackUrl(hash), label: "nearvalidate" },
      ];
    case "base":
      return [{ href: baseTxUrl(hash), label: "View on Basescan" }];
    case "solana":
      return [{ href: solanaTxUrl(hash), label: "View on Solana Explorer" }];
  }
}

export function txUrl(chain: ChainId, hash: string): string {
  switch (chain) {
    case "near":
      return nearTxUrl(hash);
    case "base":
      return baseTxUrl(hash);
    case "solana":
      return solanaTxUrl(hash);
  }
}

export function addressUrl(chain: ChainId, address: string): string {
  switch (chain) {
    case "near":
      return nearAccountUrl(address);
    case "base":
      return baseAddressUrl(address);
    case "solana":
      return solanaAddressUrl(address);
  }
}

/** `0x1234…abcd` / `alice.testnet` style shortening for the top bar. */
export function shortAddress(chain: ChainId, value: string): string {
  if (chain === "near") return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-10)}` : value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
