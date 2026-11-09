"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { toActionError } from "@/lib/errors";
import { addressUrl, CHAIN_LABEL, shortAddress, type ChainId } from "@/lib/explorer";
import { formatUnits } from "@/lib/format";
import { exportEvmDemoWallet, exportNearDemoWallet, exportSolanaDemoWallet } from "@/lib/wallet/export";
import { downloadText } from "@/lib/wallet/storage";
import { ConnectModal } from "./ConnectModal";
import { useWallets } from "./WalletProvider";

const CHAIN_DOT: Record<ChainId, string> = { near: "bg-success-400", base: "bg-info-400", solana: "bg-ember-400" };

function Amount({ value, decimals, unit, digits = 2 }: { value: bigint | null; decimals: number; unit: string; digits?: number }) {
  const { balances } = useWallets();
  if (value === null) {
    return balances.updatedAt === null ? <Skeleton className="inline-block h-3 w-12 align-middle" /> : <span className="text-ink-400">— {unit}</span>;
  }
  return (
    <span className="tabular">
      {formatUnits(value, decimals, digits)} <span className="text-ink-400">{unit}</span>
    </span>
  );
}

/** Connected wallets with balances in the top bar, the Connect button and the wallet drawer. */
export function WalletPills({ className }: { className?: string }) {
  const wallets = useWallets();
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectChain, setConnectChain] = useState<ChainId>("near");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const openConnect = (chain: ChainId) => {
    setConnectChain(chain);
    setConnectOpen(true);
  };

  const pills: { chain: ChainId; label: string; balance: React.ReactNode }[] = [];
  if (wallets.near.accountId) {
    pills.push({ chain: "near", label: shortAddress("near", wallets.near.accountId), balance: <Amount value={wallets.balances.nearYocto} decimals={24} unit="NEAR" /> });
  }
  if (wallets.evm.address) {
    pills.push({ chain: "base", label: shortAddress("base", wallets.evm.address), balance: <Amount value={wallets.balances.baseEthWei} decimals={18} unit="ETH" digits={4} /> });
  }
  if (wallets.solana.publicKey) {
    pills.push({ chain: "solana", label: shortAddress("solana", wallets.solana.publicKey), balance: <Amount value={wallets.balances.solLamports} decimals={9} unit="SOL" digits={3} /> });
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {wallets.hydrated && pills.length > 0 ? (
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          data-wallets
          aria-label="Open wallets"
          className="hidden h-8 items-center gap-3 rounded-md border border-ink-700 bg-ink-850 px-2.5 text-[12px] text-ink-100 transition-colors hover:border-ink-500 md:flex"
        >
          {pills.map((pill) => (
            <span key={pill.chain} className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-[6px]", CHAIN_DOT[pill.chain])} />
              <span className="tabular text-ink-200">{pill.label}</span>
              <span className="text-[11px]">{pill.balance}</span>
            </span>
          ))}
        </button>
      ) : null}
      {wallets.hydrated && pills.length > 0 ? (
        <button type="button" onClick={() => setDrawerOpen(true)} aria-label="Open wallets" className="flex h-8 items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 md:hidden">
          {pills.map((pill) => (
            <span key={pill.chain} aria-hidden className={cn("size-[6px]", CHAIN_DOT[pill.chain])} />
          ))}
          <span className="ml-1 text-[12px] text-ink-200">{pills.length}</span>
        </button>
      ) : null}
      <Button size="sm" variant={pills.length > 0 ? "secondary" : "primary"} onClick={() => openConnect("near")} loading={wallets.restoring} loadingLabel="Restoring" data-connect>
        {pills.length > 0 ? (
          <>
            <span className="sm:hidden">More</span>
            <span className="hidden sm:inline">Connect more</span>
          </>
        ) : (
          "Connect"
        )}
      </Button>
      <ConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} initialChain={connectChain} />
      <WalletDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onConnect={openConnect} />
    </div>
  );
}

function WalletDrawer({ open, onClose, onConnect }: { open: boolean; onClose: () => void; onConnect: (chain: ChainId) => void }) {
  const wallets = useWallets();
  const toast = useToast();

  const guard = async (action: () => Promise<void> | void, success: string) => {
    try {
      await action();
      toast.show({ tone: "success", title: success });
    } catch (error) {
      const described = toActionError(error);
      toast.show({ tone: "error", title: described.title, description: described.message });
    }
  };

  const confirmForget = (label: string, forget: () => void) => {
    if (window.confirm(`Forget the ${label} demo key stored in this browser? Export it first if you want to keep its test assets.`)) {
      forget();
      toast.show({ tone: "info", title: `${label} demo wallet forgotten` });
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Wallets" description="Balances refresh every 20 seconds. Testnet assets only.">
      <div className="flex flex-col gap-4">
        <ChainSection
          chain="near"
          address={wallets.near.accountId}
          walletName={wallets.near.walletName}
          kind={wallets.near.kind}
          rows={[
            { label: "NEAR", value: <Amount value={wallets.balances.nearYocto} decimals={24} unit="NEAR" /> },
            { label: "tUSDC", value: <Amount value={wallets.balances.nearTusdc} decimals={6} unit="tUSDC" /> },
          ]}
          note={wallets.near.kind === "demo" && !wallets.near.demoAccountExists ? "Account not created on testnet yet: open Get test funds." : null}
          onConnect={() => {
            onClose();
            onConnect("near");
          }}
          onDisconnect={() => guard(wallets.disconnectNear, "NEAR wallet disconnected")}
          onExport={wallets.near.demo ? () => downloadText(`${wallets.near.demo?.accountId ?? "rose-demo"}.json`, exportNearDemoWallet(wallets.near.demo as NonNullable<typeof wallets.near.demo>)) : null}
          onForget={wallets.near.demo ? () => confirmForget("NEAR", wallets.forgetNearDemo) : null}
        />
        <ChainSection
          chain="base"
          address={wallets.evm.address}
          walletName={wallets.evm.walletName}
          kind={wallets.evm.kind}
          rows={[
            { label: "ETH", value: <Amount value={wallets.balances.baseEthWei} decimals={18} unit="ETH" digits={4} /> },
            { label: "tUSDC", value: <Amount value={wallets.balances.baseTusdc} decimals={6} unit="tUSDC" /> },
          ]}
          note={wallets.evm.wrongChain ? "Your wallet is on another chain." : null}
          noteAction={wallets.evm.wrongChain ? { label: "Switch to Base Sepolia", onClick: () => guard(wallets.switchEvmToBaseSepolia, "Switched to Base Sepolia") } : null}
          onConnect={() => {
            onClose();
            onConnect("base");
          }}
          onDisconnect={() => guard(wallets.disconnectEvm, "EVM wallet disconnected")}
          onExport={wallets.evm.demo ? () => downloadText("rose-demo-base-sepolia.json", exportEvmDemoWallet(wallets.evm.demo as NonNullable<typeof wallets.evm.demo>)) : null}
          onForget={wallets.evm.demo ? () => confirmForget("Base", wallets.forgetEvmDemo) : null}
        />
        <ChainSection
          chain="solana"
          address={wallets.solana.publicKey}
          walletName={wallets.solana.walletName}
          kind={wallets.solana.kind}
          rows={[{ label: "SOL", value: <Amount value={wallets.balances.solLamports} decimals={9} unit="SOL" digits={3} /> }]}
          note={null}
          onConnect={() => {
            onClose();
            onConnect("solana");
          }}
          onDisconnect={() => guard(wallets.disconnectSolana, "Solana wallet disconnected")}
          onExport={wallets.solana.demo ? () => downloadText("rose-demo-solana-devnet.json", exportSolanaDemoWallet(wallets.solana.demo as NonNullable<typeof wallets.solana.demo>)) : null}
          onForget={wallets.solana.demo ? () => confirmForget("Solana", wallets.forgetSolanaDemo) : null}
        />
        <Button variant="ghost" size="sm" onClick={() => void wallets.refreshBalances()} loading={wallets.balances.loading} loadingLabel="Refreshing" className="self-start">
          Refresh balances
        </Button>
      </div>
    </Drawer>
  );
}

function ChainSection({
  chain,
  address,
  walletName,
  kind,
  rows,
  note,
  noteAction,
  onConnect,
  onDisconnect,
  onExport,
  onForget,
}: {
  chain: ChainId;
  address: string | null;
  walletName: string | null;
  kind: "external" | "demo" | null;
  rows: { label: string; value: React.ReactNode }[];
  note: string | null;
  noteAction?: { label: string; onClick: () => void } | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onExport: (() => void) | null;
  onForget: (() => void) | null;
}) {
  return (
    <section className="rounded-md border border-ink-750 bg-ink-850">
      <header className="flex items-center justify-between gap-3 border-b border-ink-750 px-3 py-2">
        <span className="flex items-center gap-2">
          <span aria-hidden className={cn("size-[6px]", CHAIN_DOT[chain])} />
          <span className="text-[12px] text-ink-200 font-medium">{CHAIN_LABEL[chain]}</span>
          {kind === "demo" ? <Badge tone="ember">Demo</Badge> : null}
        </span>
        {address ? (
          <Button variant="ghost" size="sm" onClick={onDisconnect}>
            Disconnect
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={onConnect}>
            Connect
          </Button>
        )}
      </header>
      <div className="px-3 py-2.5">
        {address ? (
          <>
            <a href={addressUrl(chain, address)} target="_blank" rel="noreferrer" className="font-mono block truncate text-[12px] text-ink-100 underline-offset-2 hover:underline">
              {address}
            </a>
            <p className="mt-0.5 text-[11px] text-ink-400">{walletName}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
              {rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-ink-400">{row.label}</dt>
                  <dd className="text-right text-ink-100">{row.value}</dd>
                </div>
              ))}
            </dl>
            {note ? (
              <p className="mt-2 flex items-center justify-between gap-2 text-[11px] text-warning-400">
                {note}
                {noteAction ? (
                  <Button variant="ghost" size="sm" onClick={noteAction.onClick}>
                    {noteAction.label}
                  </Button>
                ) : null}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-[12px] text-ink-400">Not connected.</p>
        )}
        {onExport || onForget ? (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-750 pt-2">
            {onExport ? (
              <Button variant="ghost" size="sm" onClick={onExport}>
                Export demo key
              </Button>
            ) : null}
            {onForget ? (
              <Button variant="ghost" size="sm" onClick={onForget} className="text-rose-300">
                Forget demo key
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
