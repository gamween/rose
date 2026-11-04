/**
 * Connecting a Solana wallet adapter: `select` only names the wallet, the provider then connects
 * it, so the connect surface waits for the adapter's own outcome before it reports success.
 */

import type { Adapter, WalletError } from "@solana/wallet-adapter-base";
import { RoseActionError } from "@/lib/errors";

/** How long a wallet extension may keep its approval prompt open before the connect gives up. */
const SOLANA_CONNECT_TIMEOUT_MS = 120_000;

/**
 * Resolves once `walletAdapter` emits `connect`, rejects with the error it emits (a rejection in
 * the wallet included) or after `SOLANA_CONNECT_TIMEOUT_MS`.
 */
export function waitForSolanaConnection(walletAdapter: Pick<Adapter, "on" | "off">, timeoutMs = SOLANA_CONNECT_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      walletAdapter.off("connect", onConnect);
      walletAdapter.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: WalletError) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new RoseActionError("no_wallet", "Wallet did not answer", "The wallet did not approve the connection in time. Open it and retry.", true));
    }, timeoutMs);
    walletAdapter.on("connect", onConnect);
    walletAdapter.on("error", onError);
  });
}
