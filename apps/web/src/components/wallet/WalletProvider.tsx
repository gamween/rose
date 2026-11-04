"use client";

/**
 * Unified wallet context (spec 8.4) for NEAR, Base Sepolia and Solana devnet, external or in-app
 * demo wallets. The wallet SDKs (NEAR Connect, wagmi and viem, the Solana wallet adapter and
 * web3.js, the demo wallets) live in `WalletRuntime`, which this provider imports on demand: right
 * after hydration when the browser holds a session to restore, otherwise when a wallet surface
 * opens (connect modal, test funds) or a wallet action runs. Until then the context reports no
 * wallet, and every async action awaits the runtime before it runs, so a click during the load
 * only takes longer. Everything is testnet only.
 */

import type { FinalExecutionOutcome, FunctionCall, SignerClient } from "@rose/sdk";
import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { Connector } from "wagmi";
import { RoseActionError } from "@/lib/errors";
import type { EvmDemoWallet } from "@/lib/wallet/evm-demo";
import type { NearDemoWallet } from "@/lib/wallet/near-demo";
import type { SolanaDemoWallet } from "@/lib/wallet/solana-demo";
import { hasStoredWalletSession } from "@/lib/wallet/storage";

export type WalletKind = "external" | "demo";

export type NearWalletState = {
  status: "idle" | "connecting" | "connected";
  accountId: string | null;
  kind: WalletKind | null;
  /** Name of the external wallet (from the NEAR Connect manifest) when connected through it. */
  walletName: string | null;
  demo: NearDemoWallet | null;
  /** Whether the demo account exists on testnet yet (false until the faucet creates it). */
  demoAccountExists: boolean;
};

export type EvmWalletState = {
  status: "idle" | "connecting" | "connected";
  address: `0x${string}` | null;
  kind: WalletKind | null;
  walletName: string | null;
  demo: EvmDemoWallet | null;
  /** True when an injected wallet is connected to another chain than Base Sepolia. */
  wrongChain: boolean;
};

export type SolanaWalletState = {
  status: "idle" | "connecting" | "connected";
  publicKey: string | null;
  kind: WalletKind | null;
  walletName: string | null;
  demo: SolanaDemoWallet | null;
};

export type Balances = {
  nearYocto: bigint | null;
  nearTusdc: bigint | null;
  baseEthWei: bigint | null;
  baseTusdc: bigint | null;
  solLamports: bigint | null;
  loading: boolean;
  updatedAt: number | null;
};

export type SolanaSigner = {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>;
};

/** What the wallet runtime reports once its SDKs are loaded. */
export type WalletRuntimeValue = {
  near: NearWalletState;
  evm: EvmWalletState;
  solana: SolanaWalletState;
  balances: Balances;
  refreshBalances: () => Promise<void>;
  /** Opens the NEAR Connect modal (external wallets). */
  connectNearExternal: () => Promise<void>;
  /** Creates (or restores) the in-app NEAR demo wallet; the account is funded through the faucet panel. */
  useNearDemo: () => Promise<NearDemoWallet>;
  disconnectNear: () => Promise<void>;
  forgetNearDemo: () => void;
  markNearDemoCreated: () => void;
  /** Signs and sends one engine or token call with whichever NEAR wallet is connected. */
  sendNearCall: (call: FunctionCall) => Promise<FinalExecutionOutcome>;
  evmConnectors: readonly Connector[];
  connectEvm: (connector: Connector) => Promise<void>;
  useEvmDemo: () => Promise<EvmDemoWallet>;
  disconnectEvm: () => Promise<void>;
  forgetEvmDemo: () => void;
  switchEvmToBaseSepolia: () => Promise<void>;
  /** The viem wallet client of the connected EVM wallet (demo or injected). */
  getEvmWalletClient: () => Promise<SignerClient>;
  solanaWallets: { name: string; icon: string; installed: boolean }[];
  connectSolana: (walletName: string) => Promise<void>;
  useSolanaDemo: () => Promise<SolanaDemoWallet>;
  disconnectSolana: () => Promise<void>;
  forgetSolanaDemo: () => void;
  getSolanaSigner: () => SolanaSigner;
  /** Any wallet connected on any chain. */
  anyConnected: boolean;
  /** Whether the client has restored persisted sessions (avoid flashing "Connect" during hydration). */
  hydrated: boolean;
};

/** `idle`: SDKs not requested; `loading`: importing; `ready`: runtime mounted; `failed`: the import failed (retried on the next request). */
export type WalletsStatus = "idle" | "loading" | "ready" | "failed";

export type WalletContextValue = WalletRuntimeValue & {
  walletsStatus: WalletsStatus;
  /** Loads the wallet SDKs (idempotent); resolves once the runtime has restored the sessions. */
  loadWallets: () => Promise<void>;
};

type RuntimeComponent = ComponentType<{ onValue: (value: WalletRuntimeValue) => void }>;

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallets(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallets must be used inside <WalletProvider>");
  return value;
}

const IDLE_NEAR: NearWalletState = { status: "idle", accountId: null, kind: null, walletName: null, demo: null, demoAccountExists: false };
const IDLE_EVM: EvmWalletState = { status: "idle", address: null, kind: null, walletName: null, demo: null, wrongChain: false };
const IDLE_SOLANA: SolanaWalletState = { status: "idle", publicKey: null, kind: null, walletName: null, demo: null };
const NO_BALANCES: Balances = { nearYocto: null, nearTusdc: null, baseEthWei: null, baseTusdc: null, solLamports: null, loading: false, updatedAt: null };

function loadFailure(): RoseActionError {
  return new RoseActionError("rpc", "Wallets did not load", "The wallet libraries could not be downloaded. Check your connection and retry.", true);
}

/** Schedules `run` once the main thread is idle (bounded), so restoring a session never competes with the first paint. */
function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: 1500 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 200);
  return () => window.clearTimeout(handle);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [Runtime, setRuntime] = useState<RuntimeComponent | null>(null);
  const [runtimeValue, setRuntimeValue] = useState<WalletRuntimeValue | null>(null);
  const [status, setStatus] = useState<WalletsStatus>("idle");
  const [restoring, setRestoring] = useState(true);

  const runtimeRef = useRef<WalletRuntimeValue | null>(null);
  const importRef = useRef<Promise<void> | null>(null);
  const readyRef = useRef<{ promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | null>(null);

  const ready = useCallback(() => {
    if (!readyRef.current) {
      let resolve: () => void = () => undefined;
      let reject: (error: unknown) => void = () => undefined;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      readyRef.current = { promise, resolve, reject };
    }
    return readyRef.current;
  }, []);

  const loadWallets = useCallback((): Promise<void> => {
    const pending = ready();
    if (runtimeRef.current?.hydrated) return Promise.resolve();
    importRef.current ??= import("./WalletRuntime")
      .then((mod) => {
        setRuntime(() => mod.WalletRuntime);
      })
      .catch(() => {
        importRef.current = null;
        readyRef.current = null;
        setStatus("failed");
        setRestoring(false);
        pending.reject(loadFailure());
      });
    setStatus((current) => (current === "ready" ? current : "loading"));
    return pending.promise;
  }, [ready]);

  const onValue = useCallback(
    (value: WalletRuntimeValue) => {
      runtimeRef.current = value;
      setRuntimeValue(value);
      if (value.hydrated) {
        setStatus("ready");
        ready().resolve();
      }
    },
    [ready],
  );

  /* After hydration: restore a stored session in the background, or report "no wallet" at once. */
  useEffect(() => {
    if (!hasStoredWalletSession()) {
      const timer = window.setTimeout(() => setRestoring(false), 0);
      return () => window.clearTimeout(timer);
    }
    return whenIdle(() => void loadWallets().catch(() => undefined));
  }, [loadWallets]);

  const viaRuntime = useCallback(
    async <T,>(run: (runtime: WalletRuntimeValue) => T | Promise<T>): Promise<T> => {
      await loadWallets();
      const runtime = runtimeRef.current;
      if (!runtime) throw loadFailure();
      return run(runtime);
    },
    [loadWallets],
  );

  const fallback = useMemo<WalletRuntimeValue>(
    () => ({
      near: IDLE_NEAR,
      evm: IDLE_EVM,
      solana: IDLE_SOLANA,
      balances: NO_BALANCES,
      refreshBalances: () => (runtimeRef.current ? runtimeRef.current.refreshBalances() : Promise.resolve()),
      connectNearExternal: () => viaRuntime((runtime) => runtime.connectNearExternal()),
      useNearDemo: () => viaRuntime((runtime) => runtime.useNearDemo()),
      disconnectNear: () => viaRuntime((runtime) => runtime.disconnectNear()),
      forgetNearDemo: () => void viaRuntime((runtime) => runtime.forgetNearDemo()).catch(() => undefined),
      markNearDemoCreated: () => void viaRuntime((runtime) => runtime.markNearDemoCreated()).catch(() => undefined),
      sendNearCall: (call) => viaRuntime((runtime) => runtime.sendNearCall(call)),
      evmConnectors: [],
      connectEvm: (connector) => viaRuntime((runtime) => runtime.connectEvm(connector)),
      useEvmDemo: () => viaRuntime((runtime) => runtime.useEvmDemo()),
      disconnectEvm: () => viaRuntime((runtime) => runtime.disconnectEvm()),
      forgetEvmDemo: () => void viaRuntime((runtime) => runtime.forgetEvmDemo()).catch(() => undefined),
      switchEvmToBaseSepolia: () => viaRuntime((runtime) => runtime.switchEvmToBaseSepolia()),
      getEvmWalletClient: () => viaRuntime((runtime) => runtime.getEvmWalletClient()),
      solanaWallets: [],
      connectSolana: (walletName) => viaRuntime((runtime) => runtime.connectSolana(walletName)),
      useSolanaDemo: () => viaRuntime((runtime) => runtime.useSolanaDemo()),
      disconnectSolana: () => viaRuntime((runtime) => runtime.disconnectSolana()),
      forgetSolanaDemo: () => void viaRuntime((runtime) => runtime.forgetSolanaDemo()).catch(() => undefined),
      getSolanaSigner: () => {
        throw new RoseActionError("no_wallet", "No Solana wallet", "Connect a Solana wallet on devnet first.");
      },
      anyConnected: false,
      hydrated: false,
    }),
    [viaRuntime],
  );

  const value = useMemo<WalletContextValue>(() => {
    if (runtimeValue?.hydrated) return { ...runtimeValue, walletsStatus: status, loadWallets };
    return { ...fallback, hydrated: !restoring, walletsStatus: status, loadWallets };
  }, [fallback, loadWallets, restoring, runtimeValue, status]);

  return (
    <WalletContext.Provider value={value}>
      {children}
      {Runtime ? <Runtime onValue={onValue} /> : null}
    </WalletContext.Provider>
  );
}
