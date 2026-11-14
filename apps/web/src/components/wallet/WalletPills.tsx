"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
import { connectedWallets, missingNetworks, networkInfo, type ConnectedWallet } from "@/lib/wallet/networks";
import { downloadText } from "@/lib/wallet/storage";
import { useAppActions } from "@/components/chrome/AppActions";
import { ChainLogo } from "./ChainLogo";
import { useConnectModal } from "./ConnectModal";
import { useWallets, type WalletContextValue } from "./WalletProvider";

/** The wallet menu opens under the button from this width; below it the wallets drawer opens instead. */
const MENU_MEDIA = "(min-width: 768px)";

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

/** The gas balance of each chain, the one the header menu shows. */
function GasBalance({ chain }: { chain: ChainId }) {
  const { balances } = useWallets();
  if (chain === "near") return <Amount value={balances.nearYocto} decimals={24} unit="NEAR" />;
  if (chain === "base") return <Amount value={balances.baseEthWei} decimals={18} unit="ETH" digits={4} />;
  return <Amount value={balances.solLamports} decimals={9} unit="SOL" digits={3} />;
}

function walletOf(wallets: WalletContextValue, chain: ChainId): { name: string | null; kind: "external" | "demo" | null; disconnect: () => Promise<void> } {
  if (chain === "near") return { name: wallets.near.walletName, kind: wallets.near.kind, disconnect: wallets.disconnectNear };
  if (chain === "base") return { name: wallets.evm.walletName, kind: wallets.evm.kind, disconnect: wallets.disconnectEvm };
  return { name: wallets.solana.walletName, kind: wallets.solana.kind, disconnect: wallets.disconnectSolana };
}

/** Copies an address and confirms it with a short toast. */
function useCopyAddress(): (chain: ChainId, address: string) => void {
  const toast = useToast();
  return (chain, address) => {
    navigator.clipboard.writeText(address).then(
      () => toast.show({ tone: "success", title: `${CHAIN_LABEL[chain]} address copied`, duration: 3000 }),
      () => toast.show({ tone: "error", title: "Could not copy the address", description: address }),
    );
  };
}

/** Runs a wallet action and reports it in a toast. */
function useGuard(): (action: () => Promise<void> | void, success: string) => Promise<void> {
  const toast = useToast();
  return async (action, success) => {
    try {
      await action();
      toast.show({ tone: "success", title: success });
    } catch (error) {
      const described = toActionError(error);
      toast.show({ tone: "error", title: described.title, description: described.message });
    }
  };
}

const iconButton = "flex size-7 items-center justify-center rounded-md text-ink-300 transition-colors hover:bg-ink-750 hover:text-ink-50";

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M8 1.75v5.5M4.4 3.9a5.25 5.25 0 1 0 7.2 0" />
    </svg>
  );
}

/** The chain logos of the connected wallets, overlapping, in network order. */
function LogoStack({ wallets }: { wallets: readonly ConnectedWallet[] }) {
  return (
    <span className="flex items-center" data-logo-stack>
      {wallets.map((wallet, index) => (
        <span key={wallet.chain} className={cn("relative flex rounded-[5px] ring-2 ring-ink-850", index > 0 && "-ml-1")} style={{ zIndex: wallets.length - index }}>
          <ChainLogo chain={wallet.chain} size={18} />
        </span>
      ))}
    </span>
  );
}

/**
 * The top-bar wallet control. Without a wallet: one Connect button that opens the network choice.
 * With wallets: one button with the stacked chain logos and the main address (the NEAR account when
 * connected), which opens the wallet menu (one row per wallet with balance, copy, explorer and
 * disconnect, then the networks left to connect), or the wallets drawer on small screens.
 */
export function WalletPills({ className }: { className?: string }) {
  const wallets = useWallets();
  const openConnect = useConnectModal();
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const connected = connectedWallets({ near: wallets.near.accountId, base: wallets.evm.address, solana: wallets.solana.publicKey });
  const primary = connected[0];

  /* The menu closes on Escape (focus back on its button) and on any press outside it. */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [menuOpen]);

  /* The menu closes once its last wallet disconnects. */
  if (menuOpen && !primary) setMenuOpen(false);

  return (
    <div ref={rootRef} className={cn("relative flex items-center", className)}>
      {wallets.hydrated && primary ? (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => (window.matchMedia(MENU_MEDIA).matches ? setMenuOpen((open) => !open) : setDrawerOpen(true))}
          data-wallets
          aria-label="Open wallets"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          data-variant="secondary"
          className={cn("ui-block flex h-8 items-center gap-2 rounded-md pl-1.5 pr-2 text-[12px]", menuOpen && "border-ink-500 bg-ink-750")}
        >
          <LogoStack wallets={connected} />
          <span className="font-mono hidden max-w-[180px] truncate sm:inline">{shortAddress(primary.chain, primary.address)}</span>
          <svg viewBox="0 0 10 6" width="10" height="6" shapeRendering="crispEdges" className={cn("text-ink-400 transition-transform", menuOpen && "rotate-180")} aria-hidden>
            <path d="M0 0h2v2H0zM2 2h2v2H2zM4 4h2v2H4zM6 2h2v2H6zM8 0h2v2H8z" fill="currentColor" />
          </svg>
        </button>
      ) : (
        <Button size="sm" onClick={() => openConnect()} loading={wallets.restoring} loadingLabel="Restoring" data-connect>
          Connect
        </Button>
      )}
      {menuOpen ? (
        <WalletMenu
          id={menuId}
          connected={connected}
          onConnect={(chain) => {
            setMenuOpen(false);
            openConnect(chain);
          }}
          onDetails={() => {
            setMenuOpen(false);
            setDrawerOpen(true);
          }}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
      <WalletDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onConnect={openConnect} />
    </div>
  );
}

function WalletMenu({ id, connected, onConnect, onDetails, onClose }: { id: string; connected: readonly ConnectedWallet[]; onConnect: (chain: ChainId) => void; onDetails: () => void; onClose: () => void }) {
  const wallets = useWallets();
  const { openTestFunds, openActivity } = useAppActions();
  const copy = useCopyAddress();
  const guard = useGuard();
  const ref = useRef<HTMLDivElement>(null);
  const missing = missingNetworks(connected);
  useEffect(() => ref.current?.querySelector<HTMLElement>("button, a")?.focus(), []);

  return (
    <div
      ref={ref}
      id={id}
      role="group"
      aria-label="Your wallets"
      data-wallet-menu
      className="absolute right-0 top-[calc(100%+8px)] z-50 w-[360px] animate-rise-in overflow-hidden rounded-lg border border-ink-700 bg-ink-850 shadow-(--shadow-overlay)"
    >
      <ul className="divide-y divide-ink-750">
        {connected.map(({ chain, address }) => {
          const wallet = walletOf(wallets, chain);
          return (
            <li key={chain} className="flex items-center gap-3 px-3 py-2.5" data-wallet-row={chain}>
              <ChainLogo chain={chain} size={28} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[12px] text-ink-300">
                  {CHAIN_LABEL[chain]}
                  {wallet.kind === "demo" ? <Badge tone="ember">Demo</Badge> : null}
                </p>
                <p className="font-mono truncate text-[13px] text-ink-50" title={address}>
                  {shortAddress(chain, address)}
                </p>
                <p className="truncate text-[12px] text-ink-400">
                  <GasBalance chain={chain} />
                  {wallet.name ? ` · ${wallet.name}` : null}
                </p>
                {chain === "base" && wallets.evm.wrongChain ? (
                  <button type="button" onClick={() => void guard(wallets.switchEvmToBaseSepolia, "Switched to Base Sepolia")} className="mt-1 text-[12px] text-warning-400 underline-offset-2 hover:underline">
                    On another chain: switch to Base Sepolia
                  </button>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center">
                <button type="button" onClick={() => copy(chain, address)} aria-label={`Copy the ${CHAIN_LABEL[chain]} address`} title="Copy address" className={iconButton}>
                  <CopyIcon />
                </button>
                <a href={addressUrl(chain, address)} target="_blank" rel="noreferrer" aria-label={`View the ${CHAIN_LABEL[chain]} address on the explorer`} title="View on the explorer" className={iconButton}>
                  <ExternalIcon />
                </a>
                <button type="button" onClick={() => void guard(wallet.disconnect, `${networkInfo(chain).name} wallet disconnected`)} aria-label={`Disconnect ${CHAIN_LABEL[chain]}`} title="Disconnect" className={iconButton}>
                  <PowerIcon />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {missing.length > 0 ? (
        <div className="border-t border-ink-750 px-3 py-2.5">
          <p className="mb-1.5 text-[12px] font-medium text-ink-400">Connect another network</p>
          <ul className="flex flex-col gap-1">
            {missing.map((network) => (
              <li key={network.chain}>
                <button type="button" onClick={() => onConnect(network.chain)} data-add-network={network.chain} className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-ink-800">
                  <ChainLogo chain={network.chain} size={20} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-ink-50">{network.name}</span>
                    <span className="block text-[12px] leading-snug text-ink-400">{network.requiredForTrading ? "Required for trading" : network.purpose}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="border-t border-ink-750 px-1.5 py-1.5" aria-label="Wallet tools">
        <MenuRow
          label="Get test funds"
          hint="NEAR account, gas, tUSDC, demo positions"
          data="get-funds"
          onSelect={() => {
            onClose();
            openTestFunds();
          }}
        />
        <MenuRow
          label="Activity"
          hint="The engine's recent on-chain events"
          data="activity"
          onSelect={() => {
            onClose();
            openActivity();
          }}
        />
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-ink-750 px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onDetails} data-wallet-details>
          Balances and demo keys
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void wallets.refreshBalances()} loading={wallets.balances.loading} loadingLabel="Refreshing">
          Refresh
        </Button>
      </div>
    </div>
  );
}

/** One tool row of the wallet menu (`data` picks its `data-*` hook). */
function MenuRow({ label, hint, data, onSelect }: { label: string; hint: string; data: "get-funds" | "activity"; onSelect: () => void }) {
  return (
    <li>
      <button type="button" onClick={onSelect} data-get-funds={data === "get-funds" || undefined} data-activity={data === "activity" || undefined} className="flex w-full items-baseline justify-between gap-3 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-ink-800">
        <span className="text-[13px] text-ink-50">{label}</span>
        <span className="truncate text-[12px] text-ink-400">{hint}</span>
      </button>
    </li>
  );
}

function WalletDrawer({ open, onClose, onConnect }: { open: boolean; onClose: () => void; onConnect: (chain: ChainId) => void }) {
  const wallets = useWallets();
  const { openTestFunds, openActivity } = useAppActions();
  const toast = useToast();
  const guard = useGuard();

  const confirmForget = (label: string, forget: () => void) => {
    if (window.confirm(`Forget the ${label} demo key stored in this browser? Export it first if you want to keep its test assets.`)) {
      forget();
      toast.show({ tone: "info", title: `${label} demo wallet forgotten` });
    }
  };
  const connect = (chain: ChainId) => () => {
    onClose();
    onConnect(chain);
  };

  return (
    <Drawer open={open} onClose={onClose} title="Wallets" description="Balances refresh every 20 seconds. Testnet assets only.">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onClose();
              openTestFunds();
            }}
            data-get-funds
          >
            Get test funds
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onClose();
              openActivity();
            }}
            data-activity
          >
            Activity
          </Button>
        </div>
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
          onConnect={connect("near")}
          onDisconnect={() => void guard(wallets.disconnectNear, "NEAR wallet disconnected")}
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
          noteAction={wallets.evm.wrongChain ? { label: "Switch to Base Sepolia", onClick: () => void guard(wallets.switchEvmToBaseSepolia, "Switched to Base Sepolia") } : null}
          onConnect={connect("base")}
          onDisconnect={() => void guard(wallets.disconnectEvm, "EVM wallet disconnected")}
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
          onConnect={connect("solana")}
          onDisconnect={() => void guard(wallets.disconnectSolana, "Solana wallet disconnected")}
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
  rows: { label: string; value: ReactNode }[];
  note: string | null;
  noteAction?: { label: string; onClick: () => void } | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onExport: (() => void) | null;
  onForget: (() => void) | null;
}) {
  const copy = useCopyAddress();
  return (
    <section className="ui-surface rounded-md">
      <header className="flex items-center justify-between gap-3 border-b border-ink-750 px-3 py-2">
        <span className="flex items-center gap-2">
          <ChainLogo chain={chain} size={18} />
          <span className="text-[12px] font-medium text-ink-200">{CHAIN_LABEL[chain]}</span>
          {kind === "demo" ? <Badge tone="ember">Demo</Badge> : null}
        </span>
        {address ? (
          <Button variant="ghost" size="sm" onClick={onDisconnect}>
            Disconnect
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={onConnect} data-add-network={chain}>
            Connect
          </Button>
        )}
      </header>
      <div className="px-3 py-2.5">
        {address ? (
          <>
            <div className="flex items-center gap-1">
              <a href={addressUrl(chain, address)} target="_blank" rel="noreferrer" className="font-mono block min-w-0 flex-1 truncate text-[12px] text-ink-100 underline-offset-2 hover:underline">
                {address}
              </a>
              <button type="button" onClick={() => copy(chain, address)} aria-label={`Copy the ${CHAIN_LABEL[chain]} address`} title="Copy address" className={iconButton}>
                <CopyIcon />
              </button>
            </div>
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
          <p className="text-[12px] text-ink-400">{networkInfo(chain).purpose}</p>
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
