"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { toActionError } from "@/lib/errors";
import { shortAddress, type ChainId } from "@/lib/explorer";
import { useWallets } from "./WalletProvider";
import { WalletsStatusRow } from "./WalletsStatus";

const CHAIN_TABS = [
  { id: "near", label: "NEAR" },
  { id: "base", label: "Base" },
  { id: "solana", label: "Solana" },
] as const;

function DemoRow({ title, description, onClick, busy }: { title: string; description: string; onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center justify-between gap-3 rounded-md border border-dashed border-ember-700 bg-ember-700/10 px-3 py-2.5 text-left transition-colors hover:bg-ember-700/20 disabled:opacity-60"
    >
      <span>
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink-50">
          {title}
          <Badge tone="ember">Demo</Badge>
        </span>
        <span className="mt-0.5 block text-[12px] text-ink-400">{description}</span>
      </span>
      <span className="text-[12px] text-ember-300 font-medium">Use</span>
    </button>
  );
}

function WalletRow({ name, icon, hint, onClick, busy }: { name: string; icon?: string; hint?: string; onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center gap-3 rounded-md border border-ink-700 bg-ink-900 px-3 py-2.5 text-left transition-colors hover:border-ink-500 hover:bg-ink-800 disabled:opacity-60"
    >
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element -- wallet icons are data URIs or remote and unknown at build time
        <img src={icon} alt="" width={22} height={22} className="size-[22px] rounded-sm" />
      ) : (
        <span aria-hidden className="size-[22px] rounded-sm bg-ink-700" />
      )}
      <span className="flex-1">
        <span className="block text-[13px] font-medium text-ink-50">{name}</span>
        {hint ? <span className="block text-[12px] text-ink-400">{hint}</span> : null}
      </span>
    </button>
  );
}

/** Multi-chain connect modal: one tab per chain, external wallets first, the demo wallet last. */
export function ConnectModal({ open, onClose, initialChain = "near" }: { open: boolean; onClose: () => void; initialChain?: ChainId }) {
  const wallets = useWallets();
  const toast = useToast();
  const [chain, setChain] = useState<ChainId>(initialChain);
  const [openedWith, setOpenedWith] = useState<ChainId | null>(open ? initialChain : null);
  const [busy, setBusy] = useState(false);
  /* The modal stays mounted: every opening starts on the chain the caller asked for. */
  if (open && openedWith !== initialChain) {
    setOpenedWith(initialChain);
    setChain(initialChain);
  } else if (!open && openedWith !== null) {
    setOpenedWith(null);
  }
  const { loadWallets, walletsStatus } = wallets;

  /* The wallet SDKs load when the modal opens; every row also awaits them when clicked first. */
  useEffect(() => {
    if (open) void loadWallets().catch(() => undefined);
  }, [loadWallets, open]);

  const run = async (action: () => Promise<void> | void, success: string) => {
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
    <Modal open={open} onClose={onClose} title="Connect a wallet" description="Testnets only: NEAR testnet, Base Sepolia and Solana devnet. Demo wallets live in this browser.">
      <Tabs items={CHAIN_TABS} value={chain} onChange={setChain} label="Chain" className="-mt-1 mb-4" />
      {chain === "near" ? (
        <div className="flex flex-col gap-2">
          <WalletsStatusRow what="Loading NEAR Connect…" />
          {wallets.near.accountId ? <Connected label={shortAddress("near", wallets.near.accountId)} wallet={wallets.near.walletName} onDisconnect={() => run(wallets.disconnectNear, "NEAR wallet disconnected")} busy={busy} /> : null}
          <WalletRow
            name="NEAR wallet"
            hint="Meteor, Intear, Nightly, Ledger, WalletConnect and more, through NEAR Connect"
            onClick={() => run(wallets.connectNearExternal, "NEAR wallet connected")}
            busy={busy}
          />
          <DemoRow
            title={wallets.near.demo ? `Demo wallet ${wallets.near.demo.accountId}` : "Create a demo wallet"}
            description="An ed25519 key stored in this browser. The account is created on testnet from the Get test funds panel."
            onClick={() =>
              run(async () => {
                await wallets.useNearDemo();
              }, "NEAR demo wallet ready")
            }
            busy={busy}
          />
        </div>
      ) : null}
      {chain === "base" ? (
        <div className="flex flex-col gap-2">
          {wallets.evm.address ? <Connected label={shortAddress("base", wallets.evm.address)} wallet={wallets.evm.walletName} onDisconnect={() => run(wallets.disconnectEvm, "EVM wallet disconnected")} busy={busy} /> : null}
          <WalletsStatusRow what="Looking for injected wallets in this browser…" />
          {wallets.evmConnectors.map((connector) => (
            <WalletRow
              key={connector.uid}
              name={connector.name}
              icon={connector.icon}
              hint="Injected wallet, switched to Base Sepolia (chain 84532)"
              onClick={() => run(() => wallets.connectEvm(connector), `${connector.name} connected`)}
              busy={busy}
            />
          ))}
          {walletsStatus === "ready" && wallets.evmConnectors.length === 0 ? <p className="rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px] text-ink-400">No injected wallet found in this browser. Install MetaMask or Rabby, or use the demo wallet.</p> : null}
          <DemoRow
            title={wallets.evm.demo ? `Demo wallet ${shortAddress("base", wallets.evm.demo.address)}` : "Create a demo wallet"}
            description="A private key stored in this browser, funded with Base Sepolia ETH from the faucet."
            onClick={() =>
              run(async () => {
                await wallets.useEvmDemo();
              }, "EVM demo wallet ready")
            }
            busy={busy}
          />
        </div>
      ) : null}
      {chain === "solana" ? (
        <div className="flex flex-col gap-2">
          {wallets.solana.publicKey ? <Connected label={shortAddress("solana", wallets.solana.publicKey)} wallet={wallets.solana.walletName} onDisconnect={() => run(wallets.disconnectSolana, "Solana wallet disconnected")} busy={busy} /> : null}
          <WalletsStatusRow what="Looking for Phantom and Solflare in this browser…" />
          {wallets.solanaWallets.map((wallet) => (
            <WalletRow
              key={wallet.name}
              name={wallet.name}
              icon={wallet.icon}
              hint={wallet.installed ? "Detected in this browser" : "Not installed: opens the download page"}
              onClick={() => run(() => wallets.connectSolana(wallet.name), `${wallet.name} connected`)}
              busy={busy}
            />
          ))}
          <DemoRow
            title={wallets.solana.demo ? `Demo wallet ${shortAddress("solana", wallets.solana.demo.publicKey)}` : "Create a demo wallet"}
            description="An ed25519 keypair stored in this browser, funded with devnet SOL from the faucet."
            onClick={() =>
              run(async () => {
                await wallets.useSolanaDemo();
              }, "Solana demo wallet ready")
            }
            busy={busy}
          />
        </div>
      ) : null}
    </Modal>
  );
}

function Connected({ label, wallet, onDisconnect, busy }: { label: string; wallet: string | null; onDisconnect: () => void; busy: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-success-500/40 bg-success-500/10 px-3 py-2">
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-ink-50">{label}</span>
        <span className="block text-[12px] text-ink-400">Connected{wallet ? ` with ${wallet}` : ""}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onDisconnect} disabled={busy}>
        Disconnect
      </Button>
    </div>
  );
}
