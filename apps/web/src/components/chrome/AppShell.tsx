"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { TopNav } from "@/components/chrome/TopNav";
import { Footer } from "@/components/chrome/Footer";
import { WalletPills } from "@/components/wallet/WalletPills";
import { useWallets } from "@/components/wallet/WalletProvider";
import { ConnectModal } from "@/components/wallet/ConnectModal";
import { Drawer } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { ChainId } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";
import { ActivityFeedDrawer } from "./ActivityFeed";
import { CommandPalette, usePaletteShortcut, type PaletteCommand } from "./CommandPalette";
import { GuidedTour, readTourDismissed } from "./GuidedTour";
import { tourVisible, type TourState } from "@/lib/tour";
import { TestnetBanner } from "./TestnetBanner";

type FundsDrawer = ComponentType<ComponentProps<typeof import("./GetTestFunds").GetTestFundsDrawer>>;

/** Stands in for the funds panel while its chunk downloads (it signs with the chain SDKs), or offers a retry. */
function FundsLoading({ open, failed, onClose, onRetry }: { open: boolean; failed: boolean; onClose: () => void; onRetry: () => void }) {
  return (
    <Drawer open={open} onClose={onClose} title="Get test funds" description="Testnet assets only. Nothing here has value.">
      {failed ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-danger-500/60 bg-danger-500/10 px-3 py-2 text-[12px] text-ink-200" role="alert">
          <span>The funds panel did not load. Check your connection.</span>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-[12px] text-ink-400">
          <Spinner label="Loading the funds panel" />
          Loading the funds panel…
        </p>
      )}
    </Drawer>
  );
}

/**
 * Global chrome of `/app`: top bar with wallets, testnet banner, activity feed, palette and tour.
 * `demo`: the configured engine has a guided demo ("Watch a full round"); the first-visit tour
 * stays closed on the demo itself, which explains itself and is used for screen recordings.
 */
export function AppShell({ children, demo }: { children: ReactNode; demo: boolean }) {
  const wallets = useWallets();
  const router = useRouter();
  const onDemo = (usePathname() ?? "") === ROUTES.demo;
  const [fundsOpen, setFundsOpenState] = useState(false);
  const [FundsPanel, setFundsPanel] = useState<FundsDrawer | null>(null);
  const [fundsFailed, setFundsFailed] = useState(false);
  const { loadWallets } = wallets;
  const loadFundsPanel = useCallback(() => {
    setFundsFailed(false);
    import("./GetTestFunds")
      .then((mod) => setFundsPanel(() => mod.GetTestFundsDrawer))
      .catch(() => setFundsFailed(true));
  }, []);
  const setFundsOpen = useCallback(
    (open: boolean) => {
      setFundsOpenState(open);
      if (!open) return;
      if (!FundsPanel) loadFundsPanel();
      void loadWallets().catch(() => undefined);
    },
    [FundsPanel, loadFundsPanel, loadWallets],
  );
  const [activityOpen, setActivityOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tour, setTour] = useState<TourState>("closed");
  const [tourDecided, setTourDecided] = useState(false);
  const [connect, setConnect] = useState<ChainId | null>(null);

  useEffect(() => {
    if (tourDecided) return;
    const timer = window.setTimeout(() => {
      if (!onDemo && !readTourDismissed()) setTour("auto");
      setTourDecided(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [onDemo, tourDecided]);

  usePaletteShortcut(useCallback(() => setPaletteOpen((open) => !open), []));

  const commands = useMemo<PaletteCommand[]>(
    () => [
      { id: "act-connect", label: wallets.anyConnected ? "Connect another wallet" : "Connect a wallet", group: "Actions", keywords: "near evm solana demo", run: () => setConnect("near") },
      { id: "act-funds", label: "Get test funds", group: "Actions", keywords: "faucet tusdc eth sol mint", run: () => setFundsOpen(true) },
      { id: "act-activity", label: "Open the activity feed", group: "Actions", keywords: "events history", run: () => setActivityOpen(true) },
      { id: "act-tour", label: "Replay the guided tour", group: "Help", keywords: "onboarding help", run: () => setTour("requested") },
      { id: "act-refresh", label: "Refresh balances", group: "Actions", run: () => void wallets.refreshBalances() },
      ...(demo ? [{ id: "help-demo", label: "Watch a full round (guided demo)", group: "Help" as const, keywords: "demo walkthrough seeded tour video", run: () => router.push(ROUTES.demo) }] : []),
    ],
    [demo, router, setFundsOpen, wallets],
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <TopNav
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActivityOpen(true)}
              aria-label="Open activity feed"
              title="Activity"
              data-activity
              className="hidden size-8 items-center justify-center rounded-md border border-ink-700 bg-ink-850 text-ink-200 transition-colors hover:border-ink-500 hover:text-ink-50 sm:flex"
            >
              <svg viewBox="0 0 8 8" width="12" height="12" shapeRendering="crispEdges" aria-hidden>
                <path d="M0 4h2v1H0zM2 2h1v3H2zM3 1h1v6H3zM4 3h1v3H4zM5 0h1v7H5zM6 4h2v1H6z" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              title="Command palette (⌘K)"
              data-palette
              className="hidden h-8 items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2 text-[11px] text-ink-300 transition-colors hover:border-ink-500 hover:text-ink-50 lg:flex"
            >
              <span>Search</span>
              <kbd className="font-display text-[10px] uppercase text-ink-400">⌘K</kbd>
            </button>
            <WalletPills />
          </div>
        }
      />
      <TestnetBanner onGetFunds={() => setFundsOpen(true)} demo={demo} />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 md:px-6">{children}</main>
      <Footer />
      {FundsPanel ? (
        <FundsPanel
          open={fundsOpen}
          onClose={() => setFundsOpen(false)}
          onConnect={(chain) => {
            setFundsOpen(false);
            setConnect(chain);
          }}
        />
      ) : (
        <FundsLoading open={fundsOpen} failed={fundsFailed} onClose={() => setFundsOpen(false)} onRetry={loadFundsPanel} />
      )}
      <ActivityFeedDrawer open={activityOpen} onClose={() => setActivityOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <GuidedTour open={tourVisible(tour, onDemo)} onClose={() => setTour("closed")} deciding={!tourDecided} />
      <ConnectModal open={connect !== null} onClose={() => setConnect(null)} initialChain={connect ?? "near"} />
    </div>
  );
}
