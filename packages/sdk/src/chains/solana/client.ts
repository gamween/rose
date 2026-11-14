import { PublicKey } from "@solana/web3.js";

/** Default public Solana devnet RPC. */
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

/** Streamflow program on devnet (spec 6; offsets verified live, see docs/verification.md). */
export const STREAMFLOW_DEVNET_PROGRAM = new PublicKey("HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ");

/** Solana devnet explorer link for a transaction signature. */
export function solanaTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/** Solana devnet explorer link for an address. */
export function solanaAddressUrl(address: PublicKey | string): string {
  return `https://explorer.solana.com/address/${address.toString()}?cluster=devnet`;
}
