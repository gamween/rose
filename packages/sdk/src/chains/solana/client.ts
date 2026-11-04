import { Connection, PublicKey, type Commitment } from "@solana/web3.js";

/** Default public Solana devnet RPC. */
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

/** Streamflow program on devnet (spec 6; offsets verified live, see docs/verification.md). */
export const STREAMFLOW_DEVNET_PROGRAM = new PublicKey("HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ");

/** Streamflow treasury (`STRM_TREASURY` of the js-sdk). */
export const STREAMFLOW_TREASURY = new PublicKey("5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw");

/** Solana devnet explorer link for a transaction signature. */
export function solanaTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/** Solana devnet explorer link for an address. */
export function solanaAddressUrl(address: PublicKey | string): string {
  return `https://explorer.solana.com/address/${address.toString()}?cluster=devnet`;
}

/** A web3.js connection to devnet. */
export function createSolanaConnection(rpcUrl: string = SOLANA_DEVNET_RPC, commitment: Commitment = "confirmed"): Connection {
  return new Connection(rpcUrl, commitment);
}
