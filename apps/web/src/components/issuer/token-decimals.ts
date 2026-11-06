/**
 * Decimals of the token a class schedule is typed in: ERC-20 `decimals()` on Base, the mint
 * account's `decimals` on Solana. The schedule form limits its amount fields to them as soon as
 * the token is known, so an amount with too many decimals cannot be typed at all.
 */

import type { Chain } from "@rose/sdk";
import type { Connection, PublicKey } from "@solana/web3.js";
import { isEvmAddress, isSolanaAddress } from "@/lib/amounts";

/** What the amount fields accept while the token's decimals are unknown (the most an ERC-20 commonly uses). */
export const UNKNOWN_TOKEN_DECIMALS = 18;

/** `decimals` of a classic SPL mint (parsed by the RPC), or null when the account is not one. */
export async function solanaMintDecimals(connection: Pick<Connection, "getParsedAccountInfo">, mint: PublicKey): Promise<number | null> {
  const info = await connection.getParsedAccountInfo(mint);
  const parsed = info.value?.data as { parsed?: { info?: { decimals?: unknown } } } | undefined;
  const decimals = parsed?.parsed?.info?.decimals;
  return typeof decimals === "number" ? decimals : null;
}

export type DecimalsReaders = {
  evm: (address: `0x${string}`) => Promise<number>;
  solana: (mint: string) => Promise<number | null>;
};

/** The decimals of `token` on `chain`, or null when it is not an address of that chain yet or the read fails. */
export async function scheduleTokenDecimals(chain: Chain, token: string, readers: DecimalsReaders): Promise<number | null> {
  const value = token.trim();
  try {
    if (chain === "Base") return isEvmAddress(value) ? await readers.evm(value.toLowerCase() as `0x${string}`) : null;
    return isSolanaAddress(value) ? await readers.solana(value) : null;
  } catch {
    return null;
  }
}
