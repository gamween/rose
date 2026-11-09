"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { toActionError } from "@/lib/errors";
import { CHAIN_LABEL, shortAddress, type ChainId } from "@/lib/explorer";
import { networkInfo, NETWORKS } from "@/lib/wallet/networks";
import { ChainLogo } from "./ChainLogo";
import { useWallets } from "./WalletProvider";
import { WalletsStatusRow } from "./WalletsStatus";

/** Opens the connect modal: on one network's wallets for a contextual request, on the network choice without a chain. */
export type OpenConnect = (chain?: ChainId) => void;

type ConnectRequest = { chain: ChainId | null };

const ConnectContext = createContext<OpenConnect | null>(null);

/** Hosts the app's single connect modal; any component below opens it with `useConnectModal()`. */
export function ConnectModalProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConnectRequest | null>(null);
  const openConnect = useCallback<OpenConnect>((chain) => setRequest({ chain: chain ?? null }), []);
  const close = useCallback(() => setRequest(null), []);
  return (
    <ConnectContext.Provider value={openConnect}>
      {children}
      <ConnectModal request={request} onClose={close} />
    </ConnectContext.Provider>
  );
}

export function useConnectModal(): OpenConnect {
  const openConnect = useContext(ConnectContext);
  if (!openConnect) throw new Error("useConnectModal must be used inside <ConnectModalProvider>");
  return openConnect;
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={direction === "right" ? "m6 3 5 5-5 5" : "m10 3-5 5 5 5"} />
    </svg>
  );
}

function useAddresses(): Record<ChainId, string | null> {
  const { near, evm, solana } = useWallets();
  return { near: near.accountId, base: evm.address, solana: solana.publicKey };
}

/**
 * Step 1: the network. NEAR first and marked as required for trading; Base and Solana say when a
 * holder needs them. A connected network shows its address and still opens its wallets.
 */
function NetworkStep({ onPick }: { onPick: (chain: ChainId) => void }) {
  const addresses = useAddresses();
  return (
    <div className="flex flex-col gap-2" data-network-step>
      {NETWORKS.map((network) => {
        const address = addresses[network.chain];
        return (
          <button
            key={network.chain}
            type="button"
            onClick={() => onPick(network.chain)}
            data-network={network.chain}
            className="flex w-full items-center gap-3 rounded-md border border-ink-700 bg-ink-900 px-3 py-3 text-left transition-colors hover:border-ink-500 hover:bg-ink-800"
          >
            <ChainLogo chain={network.chain} size={32} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[14px] font-medium text-ink-50">{network.name}</span>
                <span className="text-[12px] text-ink-400">{network.testnet}</span>
                {network.requiredForTrading ? <Badge tone="rose">Required for trading</Badge> : null}
              </span>
              <span className="mt-0.5 block text-[12px] leading-snug text-ink-400">{network.purpose}</span>
              {address ? (
                <span className="mt-1 flex items-center gap-1.5 text-[12px] text-success-400">
                  <span aria-hidden className="size-1.5 rounded-full bg-success-400" />
                  Connected <span className="font-mono text-ink-200">{shortAddress(network.chain, address)}</span>
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-ink-400">
              <Chevron direction="right" />
            </span>
          </button>
        );
      })}
      <p className="mt-1 text-[12px] text-ink-400">Nothing to install? Each network also has a demo wallet whose key stays in this browser.</p>
    </div>
  );
}

function WalletRow({ name, icon, hint, onClick, busy }: { name: string; icon?: string; hint?: string; onClick: () => void; busy: boolean }) {
  const [iconFailed, setIconFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center gap-3 rounded-md border border-ink-700 bg-ink-900 px-3 py-2.5 text-left transition-colors hover:border-ink-500 hover:bg-ink-800 disabled:opacity-60"
    >
      {icon && !iconFailed ? (
        // eslint-disable-next-line @next/next/no-img-element -- wallet icons are data URIs or remote and unknown at build time
        <img src={icon} alt="" width={24} height={24} className="size-6 rounded-sm" onError={() => setIconFailed(true)} />
      ) : (
        <span aria-hidden className="flex size-6 items-center justify-center rounded-sm bg-ink-700 text-[12px] font-medium text-ink-200">
          {name.charAt(0)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ink-50">{name}</span>
        {hint ? <span className="block text-[12px] text-ink-400">{hint}</span> : null}
      </span>
    </button>
  );
}

function DemoRow({ title, description, onClick, busy }: { title: string; description: string; onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-demo-wallet
      className="flex w-full items-center justify-between gap-3 rounded-md border border-dashed border-ember-700 bg-ember-700/10 px-3 py-2.5 text-left transition-colors hover:bg-ember-700/20 disabled:opacity-60"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink-50">
          {title}
          <Badge tone="ember">Demo</Badge>
        </span>
        <span className="mt-0.5 block text-[12px] text-ink-400">{description}</span>
      </span>
      <span className="shrink-0 text-[12px] font-medium text-ember-300">Use</span>
    </button>
  );
}

function Connected({ chain, address, wallet, onDisconnect, busy }: { chain: ChainId; address: string; wallet: string | null; onDisconnect: () => void; busy: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-success-500/40 bg-success-500/10 px-3 py-2">
      <span className="min-w-0">
        <span className="font-mono block truncate text-[13px] text-ink-50">{shortAddress(chain, address)}</span>
        <span className="block text-[12px] text-ink-400">Connected{wallet ? ` with ${wallet}` : ""}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onDisconnect} disabled={busy}>
        Disconnect
      </Button>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[12px] font-medium text-ink-400">{label}</h3>
      {children}
    </section>
  );
}

type Run = (action: () => Promise<unknown> | void, success: string) => Promise<void>;

/** Step 2: the wallets of one network, the connected one first, the in-browser demo wallet last. */
function WalletStep({ chain, onBack, run, busy }: { chain: ChainId; onBack: () => void; run: Run; busy: boolean }) {
  const wallets = useWallets();
  const network = networkInfo(chain);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => backRef.current?.focus(), [chain]);

  return (
    <div className="flex flex-col gap-4" data-wallet-step={chain}>
      <div className="flex items-start gap-3">
        <button
          ref={backRef}
          type="button"
          onClick={onBack}
          aria-label="Back to networks"
          className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-md text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-50"
          data-connect-back
        >
          <Chevron direction="left" />
        </button>
        <ChainLogo chain={chain} size={32} />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14px] font-medium text-ink-50">{CHAIN_LABEL[chain]}</span>
            {network.requiredForTrading ? <Badge tone="rose">Required for trading</Badge> : null}
          </p>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-400">{network.purpose}</p>
        </div>
      </div>

      {chain === "near" ? (
        <>
          {wallets.near.accountId ? <Connected chain="near" address={wallets.near.accountId} wallet={wallets.near.walletName} onDisconnect={() => void run(wallets.disconnectNear, "NEAR wallet disconnected")} busy={busy} /> : null}
          <Group label="Wallets">
            <WalletsStatusRow what="Loading NEAR Connect…" />
            {wallets.nearWallets.map((wallet) => (
              <WalletRow key={wallet.id} name={wallet.name} icon={wallet.icon} onClick={() => void run(() => wallets.connectNearExternal(wallet.id), `${wallet.name} connected`)} busy={busy} />
            ))}
            {wallets.walletsStatus === "ready" && wallets.nearWallets.length === 0 ? (
              <WalletRow name="NEAR Connect" hint="Opens the NEAR Connect wallet list" onClick={() => void run(() => wallets.connectNearExternal(), "NEAR wallet connected")} busy={busy} />
            ) : null}
          </Group>
          <Group label="Try without a wallet">
            <DemoRow
              title={wallets.near.demo ? `Demo wallet ${wallets.near.demo.accountId}` : "Create a demo wallet"}
              description="An ed25519 key stored in this browser. Its testnet account is created from the Get test funds panel."
              onClick={() => void run(wallets.useNearDemo, "NEAR demo wallet ready")}
              busy={busy}
            />
          </Group>
        </>
      ) : null}

      {chain === "base" ? (
        <>
          {wallets.evm.address ? <Connected chain="base" address={wallets.evm.address} wallet={wallets.evm.walletName} onDisconnect={() => void run(wallets.disconnectEvm, "EVM wallet disconnected")} busy={busy} /> : null}
          <Group label="Wallets">
            <WalletsStatusRow what="Looking for wallets in this browser…" />
            {wallets.evmConnectors.map((connector) => (
              <WalletRow
                key={connector.uid}
                name={connector.name}
                icon={connector.icon}
                hint="Switched to Base Sepolia (chain 84532)"
                onClick={() => void run(() => wallets.connectEvm(connector), `${connector.name} connected`)}
                busy={busy}
              />
            ))}
            {wallets.walletsStatus === "ready" && wallets.evmConnectors.length === 0 ? <p className="rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px] text-ink-400">No browser wallet found. Install MetaMask or Rabby, or use the demo wallet.</p> : null}
          </Group>
          <Group label="Try without a wallet">
            <DemoRow
              title={wallets.evm.demo ? `Demo wallet ${shortAddress("base", wallets.evm.demo.address)}` : "Create a demo wallet"}
              description="A private key stored in this browser, funded with Base Sepolia ETH from the faucet."
              onClick={() => void run(wallets.useEvmDemo, "EVM demo wallet ready")}
              busy={busy}
            />
          </Group>
        </>
      ) : null}

      {chain === "solana" ? (
        <>
          {wallets.solana.publicKey ? <Connected chain="solana" address={wallets.solana.publicKey} wallet={wallets.solana.walletName} onDisconnect={() => void run(wallets.disconnectSolana, "Solana wallet disconnected")} busy={busy} /> : null}
          <Group label="Wallets">
            <WalletsStatusRow what="Looking for Phantom and Solflare in this browser…" />
            {wallets.solanaWallets.map((wallet) => (
              <WalletRow
                key={wallet.name}
                name={wallet.name}
                icon={wallet.icon}
                hint={wallet.installed ? "Detected in this browser" : "Not installed: opens the download page"}
                onClick={() => void run(() => wallets.connectSolana(wallet.name), `${wallet.name} connected`)}
                busy={busy}
              />
            ))}
          </Group>
          <Group label="Try without a wallet">
            <DemoRow
              title={wallets.solana.demo ? `Demo wallet ${shortAddress("solana", wallets.solana.demo.publicKey)}` : "Create a demo wallet"}
              description="An ed25519 keypair stored in this browser, funded with devnet SOL from the faucet."
              onClick={() => void run(wallets.useSolanaDemo, "Solana demo wallet ready")}
              busy={busy}
            />
          </Group>
        </>
      ) : null}
    </div>
  );
}

/**
 * Connect modal, network first then wallet (as NEAR Intents, Rango and Dynamic's chain tabs do). A
 * request with a chain opens straight on that network's wallets, with a way back to the networks
 * (as LI.FI's "Select {chain} wallet" and Reown AppKit's namespace-scoped `open` do).
 */
function ConnectModal({ request, onClose }: { request: ConnectRequest | null; onClose: () => void }) {
  const wallets = useWallets();
  const toast = useToast();
  const [shown, setShown] = useState<ConnectRequest | null>(request);
  const [step, setStep] = useState<ChainId | null>(request?.chain ?? null);
  const [busy, setBusy] = useState(false);
  /* The modal stays mounted: every request starts on the step it asked for. */
  if (request !== shown) {
    setShown(request);
    if (request) setStep(request.chain);
  }
  const open = request !== null;
  const { loadWallets } = wallets;
  const networksRef = useRef<HTMLDivElement>(null);

  /* The wallet SDKs load when the modal opens; every row also awaits them when clicked first. */
  useEffect(() => {
    if (open) void loadWallets().catch(() => undefined);
  }, [loadWallets, open]);

  const back = () => {
    const from = step;
    setStep(null);
    window.requestAnimationFrame(() => networksRef.current?.querySelector<HTMLButtonElement>(`[data-network='${from ?? "near"}']`)?.focus());
  };

  const run: Run = async (action, success) => {
    setBusy(true);
    try {
      await action();
      toast.show({ tone: "success", title: success });
      onClose();
    } catch (error) {
      const described = toActionError(error);
      if (described.kind !== "rejected") toast.show({ tone: "error", title: described.title, description: described.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect a wallet"
      description={step === null ? "Choose a network, then a wallet. Testnets only: nothing here has real value." : "Choose a wallet. Testnets only: nothing here has real value."}
    >
      {step === null ? (
        <div ref={networksRef}>
          <NetworkStep onPick={setStep} />
        </div>
      ) : (
        <WalletStep chain={step} onBack={back} run={run} busy={busy} />
      )}
    </Modal>
  );
}
