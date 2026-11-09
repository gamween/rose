import type { ChainId } from "@/lib/explorer";

export type NetworkInfo = {
  chain: ChainId;
  /** Network name as the wallets show it. */
  name: string;
  /** The testnet rose uses on that network. */
  testnet: string;
  /** Why someone connects it, in plain words. */
  purpose: string;
  /** NEAR holds the account every bid, ask and claim is signed with. */
  requiredForTrading: boolean;
};

/**
 * The networks rose connects, in the order the connect modal offers them. NEAR comes first: it is
 * the ledger and the only wallet a buyer needs. Base and Solana only matter to a holder whose
 * stream lives there (deposit, then payouts to the same chain).
 */
export const NETWORKS: readonly NetworkInfo[] = [
  { chain: "near", name: "NEAR", testnet: "Testnet", purpose: "Your rose account: it holds your units and cash and signs every bid, ask and claim.", requiredForTrading: true },
  { chain: "base", name: "Base", testnet: "Sepolia", purpose: "Only if your position is a Sablier stream on Base: deposit it and receive the payouts there.", requiredForTrading: false },
  { chain: "solana", name: "Solana", testnet: "Devnet", purpose: "Only if your position is a Streamflow stream on Solana: deposit it and receive the payouts there.", requiredForTrading: false },
];

export function networkInfo(chain: ChainId): NetworkInfo {
  const info = NETWORKS.find((network) => network.chain === chain);
  if (!info) throw new Error(`Unknown network ${chain}`);
  return info;
}

export type ConnectedWallet = { chain: ChainId; address: string };

/**
 * The connected wallets in network order. The header labels its wallet button with the first one,
 * which is the NEAR account whenever one is connected.
 */
export function connectedWallets(addresses: Record<ChainId, string | null>): ConnectedWallet[] {
  return NETWORKS.flatMap(({ chain }) => {
    const address = addresses[chain];
    return address ? [{ chain, address }] : [];
  });
}

/** The networks a connected-wallets menu still offers to connect, in network order. */
export function missingNetworks(connected: readonly ConnectedWallet[]): NetworkInfo[] {
  return NETWORKS.filter((network) => !connected.some((wallet) => wallet.chain === network.chain));
}
