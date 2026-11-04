"use client";

/**
 * Wallet runtime behind the unified wallet context (spec 8.4), loaded on demand by
 * `WalletProvider` so read-only pages never carry these SDKs in their critical path. NEAR through
 * NEAR Connect (`@hot-labs/near-connect`, the connector docs.near.org recommends; on testnet it
 * lists Meteor, Intear, Nightly, Ledger, Unity, WalletConnect and NEAR CLI) or the in-app demo
 * wallet; EVM through wagmi (injected wallets, EIP-6963 discovery) or the in-app demo wallet on
 * Base Sepolia; Solana through the wallet adapter (Phantom, Solflare) or the in-app demo keypair
 * on devnet. Balances per chain are read directly from the RPCs. Everything is testnet only. It
 * renders nothing: it reports the context value to the provider, which hands it to every
 * `useWallets()` consumer.
 */

import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { ConnectionProvider, useWallet, WalletProvider as SolanaAdapterProvider } from "@solana/wallet-adapter-react";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { PublicKey } from "@solana/web3.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NearRpc, NearRpcError, outcomeFailure, type FinalExecutionOutcome, type FunctionCall, type SignerClient } from "@rose/sdk";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi } from "viem";
import { createConfig, http, useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain, useWalletClient, WagmiProvider, type Connector } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { getWalletClient } from "wagmi/actions";
import { injected } from "wagmi/connectors";
import { BASE_SEPOLIA_RPC_URL, deployedAddress, NEAR_RPC_FALLBACK_URL, NEAR_RPC_URL, NEAR_TUSDC_ACCOUNT, SOLANA_DEVNET_RPC_URL } from "@/lib/deployment";
import { failureToActionError, RoseActionError } from "@/lib/errors";
import { basePublicClient, evmDemoWalletClient, forgetEvmDemoWallet, generateEvmDemoWallet, loadEvmDemoWallet, saveEvmDemoWallet, type EvmDemoWallet } from "@/lib/wallet/evm-demo";
import {
  forgetNearDemoWallet,
  generateNearDemoWallet,
  loadNearDemoWallet,
  nearAccountExists,
  saveNearDemoWallet,
  sendNearDemoCall,
  withFreshDemoAccountId,
  type NearDemoWallet,
} from "@/lib/wallet/near-demo";
import {
  forgetSolanaDemoWallet,
  generateSolanaDemoWallet,
  loadSolanaDemoWallet,
  saveSolanaDemoWallet,
  signWithSolanaDemo,
  solanaConnection,
  solanaDemoPublicKey,
  type SolanaDemoWallet,
} from "@/lib/wallet/solana-demo";
import { waitForSolanaConnection } from "@/lib/wallet/solana-connect";
import { DEMO_STORAGE_KEYS, readStored, removeStored, writeStored } from "@/lib/wallet/storage";
import type { Balances, EvmWalletState, NearWalletState, SolanaSigner, SolanaWalletState, WalletKind, WalletRuntimeValue } from "./WalletProvider";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });

const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [injected()],
  transports: { [baseSepolia.id]: http(BASE_SEPOLIA_RPC_URL) },
  ssr: true,
});

const BALANCE_POLL_MS = 20_000;
const nearRpc = new NearRpc({ endpoints: [NEAR_RPC_URL, NEAR_RPC_FALLBACK_URL] });

const FINAL_HEAD_TIMEOUT_MS = 10_000;

/**
 * Waits until the final head reaches the optimistic head seen after a transaction, so the views
 * the page re-reads next (all at `final` finality) already include it. Bounded: a slow RPC only
 * delays the refresh, it never fails the action.
 */
async function waitForFinalHead(): Promise<void> {
  try {
    const target = (await nearRpc.block("optimistic")).header.height;
    const started = Date.now();
    while (Date.now() - started < FINAL_HEAD_TIMEOUT_MS) {
      if ((await nearRpc.block("final")).header.height >= target) return;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  } catch {
    // The transaction already succeeded; a view refresh will catch up on the next poll.
  }
}

/**
 * Every adapter error also rejects the call that caused it (connect, signTransaction), which the
 * calling surface shows as a toast; the provider's default handler would only add a console error.
 */
function ignoreSolanaAdapterError(): void {}

type NearConnectorModule = typeof import("@hot-labs/near-connect");

async function loadNearConnector(): Promise<NearConnector> {
  const mod: NearConnectorModule = await import("@hot-labs/near-connect");
  return new mod.NearConnector({ network: "testnet", footerBranding: null, autoConnect: true });
}

function RuntimeBridge({ onValue }: { onValue: (value: WalletRuntimeValue) => void }) {
  const [hydrated, setHydrated] = useState(false);

  const connectorRef = useRef<Promise<NearConnector> | null>(null);
  const nearWalletRef = useRef<NearWalletBase | null>(null);
  const [near, setNear] = useState<NearWalletState>({ status: "idle", accountId: null, kind: null, walletName: null, demo: null, demoAccountExists: false });

  const [evmDemo, setEvmDemo] = useState<EvmDemoWallet | null>(null);
  const evmAccount = useAccount();
  const evmConnectors = useConnectors();
  const { connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { data: injectedWalletClient } = useWalletClient({ chainId: baseSepolia.id });

  const [solanaDemo, setSolanaDemo] = useState<SolanaDemoWallet | null>(null);
  const adapter = useWallet();

  const [balances, setBalances] = useState<Balances>({ nearYocto: null, nearTusdc: null, baseEthWei: null, baseTusdc: null, solLamports: null, loading: false, updatedAt: null });

  const getConnector = useCallback((): Promise<NearConnector> => {
    connectorRef.current ??= loadNearConnector();
    return connectorRef.current;
  }, []);

  /* Restore persisted sessions once on the client. */
  useEffect(() => {
    let cancelled = false;
    const restoreSessions = async () => {
      await Promise.resolve();
      if (cancelled) return;
      const nearDemo = loadNearDemoWallet();
      const preferred = readStored<WalletKind>(DEMO_STORAGE_KEYS.preferredNear);
      if (nearDemo && preferred === "demo") {
        setNear({ status: "connected", accountId: nearDemo.accountId, kind: "demo", walletName: "Demo wallet", demo: nearDemo, demoAccountExists: false });
        void nearAccountExists(nearDemo.accountId).then((exists) => {
          if (!cancelled) setNear((state) => (state.demo?.accountId === nearDemo.accountId ? { ...state, demoAccountExists: exists } : state));
        });
      } else if (nearDemo) {
        setNear((state) => ({ ...state, demo: nearDemo }));
      }
      if (preferred === "external") {
        void getConnector()
          .then(async (connector) => {
            const { wallet, accounts } = await connector.getConnectedWallet();
            const account = accounts[0];
            if (cancelled || !account) return;
            nearWalletRef.current = wallet;
            setNear((state) => ({ ...state, status: "connected", accountId: account.accountId, kind: "external", walletName: wallet.manifest.name }));
          })
          .catch(() => {
            if (!cancelled) removeStored(DEMO_STORAGE_KEYS.preferredNear);
          });
      }
      setEvmDemo(loadEvmDemoWallet());
      setSolanaDemo(loadSolanaDemoWallet());
      setHydrated(true);
    };
    void restoreSessions();
    return () => {
      cancelled = true;
    };
  }, [getConnector]);

  /* NEAR Connect events keep the state in sync with the modal. */
  useEffect(() => {
    let disposed = false;
    void getConnector().then((connector) => {
      if (disposed) return;
      connector.on("wallet:signIn", (payload) => {
        const account = payload.accounts[0];
        if (!payload.success || !account) return;
        nearWalletRef.current = payload.wallet;
        writeStored(DEMO_STORAGE_KEYS.preferredNear, "external");
        setNear((state) => ({ ...state, status: "connected", accountId: account.accountId, kind: "external", walletName: payload.wallet.manifest.name }));
      });
      connector.on("wallet:signOut", () => {
        nearWalletRef.current = null;
        setNear((state) => (state.kind === "external" ? { ...state, status: "idle", accountId: null, kind: null, walletName: null } : state));
      });
    });
    return () => {
      disposed = true;
    };
  }, [getConnector]);

  const connectNearExternal = useCallback(async () => {
    setNear((state) => ({ ...state, status: "connecting" }));
    try {
      const connector = await getConnector();
      await connector.connect();
    } catch (error) {
      setNear((state) => (state.status === "connecting" ? { ...state, status: state.accountId ? "connected" : "idle" } : state));
      throw error;
    }
  }, [getConnector]);

  const useNearDemo = useCallback((): Promise<NearDemoWallet> => {
    const wallet = loadNearDemoWallet() ?? generateNearDemoWallet();
    saveNearDemoWallet(wallet);
    writeStored(DEMO_STORAGE_KEYS.preferredNear, "demo");
    setNear({ status: "connected", accountId: wallet.accountId, kind: "demo", walletName: "Demo wallet", demo: wallet, demoAccountExists: false });
    void nearAccountExists(wallet.accountId).then((exists) => setNear((state) => (state.demo?.accountId === wallet.accountId ? { ...state, demoAccountExists: exists } : state)));
    return Promise.resolve(wallet);
  }, []);

  const markNearDemoCreated = useCallback(() => setNear((state) => ({ ...state, demoAccountExists: true })), []);

  const disconnectNear = useCallback(async () => {
    removeStored(DEMO_STORAGE_KEYS.preferredNear);
    if (near.kind === "external") {
      const connector = await getConnector();
      await connector.disconnect().catch(() => undefined);
      nearWalletRef.current = null;
    }
    setNear((state) => ({ ...state, status: "idle", accountId: null, kind: null, walletName: null }));
  }, [getConnector, near.kind]);

  const renewNearDemoAccountId = useCallback((): Promise<NearDemoWallet> => {
    const current = loadNearDemoWallet();
    if (!current) return Promise.reject(new RoseActionError("no_wallet", "No NEAR demo wallet", "Create the demo wallet first."));
    const wallet = withFreshDemoAccountId(current);
    saveNearDemoWallet(wallet);
    setNear((state) => (state.kind === "demo" ? { ...state, accountId: wallet.accountId, demo: wallet, demoAccountExists: false } : { ...state, demo: wallet }));
    return Promise.resolve(wallet);
  }, []);

  const forgetNearDemo = useCallback(() => {
    forgetNearDemoWallet();
    removeStored(DEMO_STORAGE_KEYS.preferredNear);
    setNear((state) => (state.kind === "demo" ? { status: "idle", accountId: null, kind: null, walletName: null, demo: null, demoAccountExists: false } : { ...state, demo: null }));
  }, []);

  const sendNearCall = useCallback(
    async (call: FunctionCall): Promise<FinalExecutionOutcome> => {
      if (near.kind === "demo" && near.demo) {
        if (!near.demoAccountExists) {
          const exists = await nearAccountExists(near.demo.accountId);
          if (!exists) throw new RoseActionError("insufficient_balance", "Demo account not created yet", "Open \"Get test funds\" and create the NEAR demo account first.");
          markNearDemoCreated();
        }
        const outcome = await sendNearDemoCall(near.demo, call);
        await waitForFinalHead();
        return outcome;
      }
      const wallet = nearWalletRef.current;
      if (!wallet || !near.accountId) throw new RoseActionError("no_wallet", "No NEAR wallet", "Connect a NEAR wallet first.");
      const outcome = (await wallet.signAndSendTransaction({
        signerId: near.accountId,
        receiverId: call.receiverId,
        actions: [{ type: "FunctionCall", params: { methodName: call.methodName, args: call.args, gas: call.gas.toString(), deposit: call.deposit.toString() } }],
      })) as unknown as FinalExecutionOutcome;
      const failure = outcomeFailure(outcome);
      if (failure !== null) {
        const described = failureToActionError(failure);
        throw new RoseActionError(described.kind, described.title, described.message, described.retryable);
      }
      await waitForFinalHead();
      return outcome;
    },
    [markNearDemoCreated, near.accountId, near.demo, near.demoAccountExists, near.kind],
  );

  /* EVM */
  const evmPreferred = evmDemo !== null && readStored<WalletKind>(DEMO_STORAGE_KEYS.preferredEvm) === "demo";
  const evm: EvmWalletState = useMemo(() => {
    if (evmAccount.isConnected && evmAccount.address && !evmPreferred) {
      return {
        status: "connected",
        address: evmAccount.address,
        kind: "external",
        walletName: evmAccount.connector?.name ?? "Injected wallet",
        demo: evmDemo,
        wrongChain: evmAccount.chainId !== baseSepolia.id,
      };
    }
    if (evmDemo && evmPreferred) return { status: "connected", address: evmDemo.address, kind: "demo", walletName: "Demo wallet", demo: evmDemo, wrongChain: false };
    return { status: evmAccount.isConnecting ? "connecting" : "idle", address: null, kind: null, walletName: null, demo: evmDemo, wrongChain: false };
  }, [evmAccount.address, evmAccount.chainId, evmAccount.connector?.name, evmAccount.isConnected, evmAccount.isConnecting, evmDemo, evmPreferred]);

  const connectEvm = useCallback(
    async (connector: Connector) => {
      removeStored(DEMO_STORAGE_KEYS.preferredEvm);
      await connectAsync({ connector, chainId: baseSepolia.id });
    },
    [connectAsync],
  );

  const useEvmDemo = useCallback((): Promise<EvmDemoWallet> => {
    const wallet = loadEvmDemoWallet() ?? generateEvmDemoWallet();
    saveEvmDemoWallet(wallet);
    writeStored(DEMO_STORAGE_KEYS.preferredEvm, "demo");
    setEvmDemo({ ...wallet });
    return Promise.resolve(wallet);
  }, []);

  const disconnectEvm = useCallback(async () => {
    removeStored(DEMO_STORAGE_KEYS.preferredEvm);
    if (evmAccount.isConnected) await disconnectAsync();
    setEvmDemo((wallet) => (wallet ? { ...wallet } : null));
  }, [disconnectAsync, evmAccount.isConnected]);

  const forgetEvmDemo = useCallback(() => {
    forgetEvmDemoWallet();
    removeStored(DEMO_STORAGE_KEYS.preferredEvm);
    setEvmDemo(null);
  }, []);

  const switchEvmToBaseSepolia = useCallback(async () => {
    await switchChainAsync({ chainId: baseSepolia.id });
  }, [switchChainAsync]);

  const getEvmWalletClient = useCallback(async (): Promise<SignerClient> => {
    if (evm.kind === "demo" && evm.demo) return evmDemoWalletClient(evm.demo);
    if (evm.kind === "external") {
      if (evm.wrongChain) {
        await switchChainAsync({ chainId: baseSepolia.id });
        /* The hook value is still the client of the previous chain until the next render. */
        return getWalletClient(wagmiConfig, { chainId: baseSepolia.id });
      }
      if (injectedWalletClient) return injectedWalletClient;
      return getWalletClient(wagmiConfig, { chainId: baseSepolia.id }).catch(() => {
        throw new RoseActionError("no_wallet", "Wallet not ready", "The injected wallet did not expose a signer. Reconnect and retry.", true);
      });
    }
    throw new RoseActionError("no_wallet", "No EVM wallet", "Connect an EVM wallet on Base Sepolia first.");
  }, [evm.demo, evm.kind, evm.wrongChain, injectedWalletClient, switchChainAsync]);

  /* Solana */
  const solanaPreferred = solanaDemo !== null && readStored<WalletKind>(DEMO_STORAGE_KEYS.preferredSolana) === "demo";
  const solana: SolanaWalletState = useMemo(() => {
    if (adapter.connected && adapter.publicKey && !solanaPreferred) {
      return { status: "connected", publicKey: adapter.publicKey.toBase58(), kind: "external", walletName: adapter.wallet?.adapter.name ?? "Wallet", demo: solanaDemo };
    }
    if (solanaDemo && solanaPreferred) return { status: "connected", publicKey: solanaDemo.publicKey, kind: "demo", walletName: "Demo wallet", demo: solanaDemo };
    return { status: adapter.connecting ? "connecting" : "idle", publicKey: null, kind: null, walletName: null, demo: solanaDemo };
  }, [adapter.connected, adapter.connecting, adapter.publicKey, adapter.wallet?.adapter.name, solanaDemo, solanaPreferred]);

  const solanaWallets = useMemo(
    () => adapter.wallets.map((wallet) => ({ name: wallet.adapter.name, icon: wallet.adapter.icon, installed: wallet.readyState === "Installed" || wallet.readyState === "Loadable" })),
    [adapter.wallets],
  );

  const connectSolana = useCallback(
    async (walletName: string) => {
      removeStored(DEMO_STORAGE_KEYS.preferredSolana);
      const target = adapter.wallets.find((wallet) => wallet.adapter.name === walletName);
      if (!target) throw new RoseActionError("no_wallet", "Wallet not found", `${walletName} is not available in this browser.`);
      if (target.readyState !== "Installed" && target.readyState !== "Loadable") {
        window.open(target.adapter.url, "_blank", "noopener");
        throw new RoseActionError("no_wallet", `${walletName} not installed`, `Install ${walletName} and retry.`);
      }
      if (adapter.wallet?.adapter.name === walletName) {
        await adapter.connect();
        return;
      }
      if (target.adapter.connected) {
        adapter.select(target.adapter.name);
        return;
      }
      /* Selecting makes the provider connect the adapter (autoConnect); resolve on its outcome. */
      const connected = waitForSolanaConnection(target.adapter);
      adapter.select(target.adapter.name);
      await connected;
    },
    [adapter],
  );

  const useSolanaDemo = useCallback((): Promise<SolanaDemoWallet> => {
    const wallet = loadSolanaDemoWallet() ?? generateSolanaDemoWallet();
    saveSolanaDemoWallet(wallet);
    writeStored(DEMO_STORAGE_KEYS.preferredSolana, "demo");
    setSolanaDemo({ ...wallet });
    return Promise.resolve(wallet);
  }, []);

  const disconnectSolana = useCallback(async () => {
    removeStored(DEMO_STORAGE_KEYS.preferredSolana);
    if (adapter.connected) await adapter.disconnect();
    setSolanaDemo((wallet) => (wallet ? { ...wallet } : null));
  }, [adapter]);

  const forgetSolanaDemo = useCallback(() => {
    forgetSolanaDemoWallet();
    removeStored(DEMO_STORAGE_KEYS.preferredSolana);
    setSolanaDemo(null);
  }, []);

  const getSolanaSigner = useCallback((): SolanaSigner => {
    if (solana.kind === "demo" && solana.demo) {
      const demo = solana.demo;
      return { publicKey: solanaDemoPublicKey(demo), signTransaction: (transaction) => Promise.resolve(signWithSolanaDemo(demo, transaction)) };
    }
    if (solana.kind === "external" && adapter.publicKey && adapter.signTransaction) {
      return { publicKey: adapter.publicKey, signTransaction: adapter.signTransaction };
    }
    throw new RoseActionError("no_wallet", "No Solana wallet", "Connect a Solana wallet on devnet first.");
  }, [adapter.publicKey, adapter.signTransaction, solana.demo, solana.kind]);

  /* Balances */
  const refreshBalances = useCallback(async () => {
    setBalances((state) => ({ ...state, loading: true }));
    const [nearYocto, nearTusdc, baseEthWei, baseTusdc, solLamports] = await Promise.all([
      near.accountId
        ? nearRpc
            .viewAccount(near.accountId)
            .then((view) => BigInt(view.amount))
            .catch((error: unknown) => (error instanceof NearRpcError && error.kind === "account_missing" ? 0n : null))
        : Promise.resolve(null),
      near.accountId
        ? nearRpc
            .viewFunction<string>(NEAR_TUSDC_ACCOUNT, "ft_balance_of", { account_id: near.accountId })
            .then((result) => BigInt(result.value))
            .catch(() => null)
        : Promise.resolve(null),
      evm.address ? basePublicClient().getBalance({ address: evm.address }).catch(() => null) : Promise.resolve(null),
      evm.address && deployedAddress("baseTestUsdc")
        ? basePublicClient()
            .readContract({ address: deployedAddress("baseTestUsdc") as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [evm.address] })
            .catch(() => null)
        : Promise.resolve(null),
      solana.publicKey
        ? solanaConnection()
            .getBalance(new PublicKey(solana.publicKey))
            .then((lamports) => BigInt(lamports))
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    setBalances({ nearYocto, nearTusdc, baseEthWei, baseTusdc, solLamports, loading: false, updatedAt: Date.now() });
  }, [evm.address, near.accountId, solana.publicKey]);

  useEffect(() => {
    if (!hydrated) return;
    const tick = () => void refreshBalances();
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, BALANCE_POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [hydrated, refreshBalances]);

  const value = useMemo<WalletRuntimeValue>(
    () => ({
      near,
      evm,
      solana,
      balances,
      refreshBalances,
      connectNearExternal,
      useNearDemo,
      disconnectNear,
      forgetNearDemo,
      markNearDemoCreated,
      renewNearDemoAccountId,
      sendNearCall,
      evmConnectors,
      connectEvm,
      useEvmDemo,
      disconnectEvm,
      forgetEvmDemo,
      switchEvmToBaseSepolia,
      getEvmWalletClient,
      solanaWallets,
      connectSolana,
      useSolanaDemo,
      disconnectSolana,
      forgetSolanaDemo,
      getSolanaSigner,
      anyConnected: near.status === "connected" || evm.status === "connected" || solana.status === "connected",
      hydrated,
    }),
    [
      near,
      evm,
      solana,
      balances,
      refreshBalances,
      connectNearExternal,
      useNearDemo,
      disconnectNear,
      forgetNearDemo,
      markNearDemoCreated,
      renewNearDemoAccountId,
      sendNearCall,
      evmConnectors,
      connectEvm,
      useEvmDemo,
      disconnectEvm,
      forgetEvmDemo,
      switchEvmToBaseSepolia,
      getEvmWalletClient,
      solanaWallets,
      connectSolana,
      useSolanaDemo,
      disconnectSolana,
      forgetSolanaDemo,
      getSolanaSigner,
      hydrated,
    ],
  );

  useEffect(() => onValue(value), [onValue, value]);

  return null;
}

/**
 * Mounts wagmi, react-query and the Solana wallet adapter around the bridge that reports the
 * context value. Memoized on purpose: the provider re-renders on every reported value, and a
 * runtime re-rendered from there recomputes a new value and reports it again, a render loop that
 * keeps the main thread busy and every client navigation from committing.
 */
export const WalletRuntime = memo(function WalletRuntime({ onValue }: { onValue: (value: WalletRuntimeValue) => void }) {
  const solanaAdapters = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet })], []);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider endpoint={SOLANA_DEVNET_RPC_URL} config={{ commitment: "confirmed" }}>
          <SolanaAdapterProvider wallets={solanaAdapters} autoConnect onError={ignoreSolanaAdapterError}>
            <RuntimeBridge onValue={onValue} />
          </SolanaAdapterProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
});
