/**
 * Explorer links. NearBlocks testnet stopped indexing in September 2026, so NEAR links go to
 * NEAR Rocks (FastNear, the app's RPC provider); see docs/verification.md "Explorers".
 */
export const EXPLORERS = {
  nearAccount: (accountId: string) => `https://testnet.near.rocks/account/${accountId}`,
  nearTx: (hash: string) => `https://testnet.near.rocks/tx/${hash}`,
  nearBlock: (height: string | number) => `https://testnet.near.rocks/block/${height}`,
  baseAddress: (address: string) => `https://sepolia.basescan.org/address/${address}`,
  baseTx: (hash: string) => `https://sepolia.basescan.org/tx/${hash}`,
  solanaAddress: (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`,
  solanaTx: (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
} as const;

/** `0x1234…abcd` for hashes and addresses that do not fit. */
export function shorten(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
