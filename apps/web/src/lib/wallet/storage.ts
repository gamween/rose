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
