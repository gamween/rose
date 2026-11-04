/**
 * Browser storage of the in-app demo wallets. Keys live only in `localStorage` of this origin,
 * are clearly labeled "demo", and can be exported or forgotten from the wallet menu. They hold
 * testnet assets only.
 */

export const DEMO_STORAGE_KEYS = {
  near: "rose.demo.near",
  evm: "rose.demo.evm",
  solana: "rose.demo.solana",
  preferredNear: "rose.wallet.near.preferred",
  preferredEvm: "rose.wallet.evm.preferred",
  preferredSolana: "rose.wallet.solana.preferred",
} as const;

export type DemoStorageKey = (typeof DEMO_STORAGE_KEYS)[keyof typeof DEMO_STORAGE_KEYS];

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStored<T>(key: DemoStorageKey): T | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function writeStored(key: DemoStorageKey, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows or blocked storage: the demo wallet then lives for the session only.
  }
}

export function removeStored(key: DemoStorageKey): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // Nothing to forget when storage is unavailable.
  }
}

/**
 * Whether this browser holds a wallet session to restore: a rose wallet preference (demo or
 * external), a wagmi connection that was not disconnected (`wagmi.recentConnectorId` without the
 * `<id>.disconnected` shim), or the Solana wallet adapter's remembered wallet (`walletName`). The
 * wallet SDKs load right after hydration only in that case. Two rarer reconnections now wait for
 * the first wallet surface instead: an injected EVM wallet that authorized the site after its
 * wagmi keys were cleared, and a wallet that a parent frame injects into NEAR Connect.
 */
export function hasStoredWalletSession(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    if (readStored(DEMO_STORAGE_KEYS.preferredNear) || readStored(DEMO_STORAGE_KEYS.preferredEvm) || readStored(DEMO_STORAGE_KEYS.preferredSolana)) return true;
    if (store.getItem("walletName")) return true;
    const recent = store.getItem("wagmi.recentConnectorId");
    if (!recent) return false;
    const connectorId = JSON.parse(recent) as unknown;
    return typeof connectorId === "string" && store.getItem(`wagmi.${connectorId}.disconnected`) === null;
  } catch {
    return false;
  }
}

/** Triggers a download of `text` as `filename` (used by the "Export key" buttons). */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
