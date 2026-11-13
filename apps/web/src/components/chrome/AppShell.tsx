"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { TopNav, type MenuAction } from "@/components/chrome/TopNav";
import { Footer } from "@/components/chrome/Footer";
import { WalletPills } from "@/components/wallet/WalletPills";
import { useWallets } from "@/components/wallet/WalletProvider";
import { ConnectModalProvider, useConnectModal } from "@/components/wallet/ConnectModal";
import { Drawer } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { Spinner } from "@/components/ui/Spinner";
import { ROUTES } from "@/lib/routes";
import { ActivityFeedDrawer } from "./ActivityFeed";
import { AppActionsProvider, type AppActions } from "./AppActions";
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
          <Button variant="ghost" size="sm" onClick={onRetry} aria-label="Retry loading the funds panel">
            Retry
          </Button>
        </div>
      ) : (
        <p role="status" className="flex items-center gap-2 text-[12px] text-ink-400">
          <span aria-hidden className="inline-flex">
            <Spinner />
          </span>
          Loading the funds panel…
        </p>
      )}
    </Drawer>
  );
}

/**
 * Global chrome of `/app`: top bar with wallets, testnet banner, activity feed, palette and tour,
 * around the app's single connect modal (any page opens it with `useConnectModal()`).
 * `demo`: the configured engine has a guided demo ("Watch a full round"); the first-visit tour
 * stays closed on the demo itself, which explains itself and is used for screen recordings.
 */
export function AppShell({ children, demo }: { children: ReactNode; demo: boolean }) {
  return (
    <ConnectModalProvider>
      <AppChrome demo={demo}>{children}</AppChrome>
    </ConnectModalProvider>
  );
}

function AppChrome({ children, demo }: { children: ReactNode; demo: boolean }) {
  const wallets = useWallets();
  const openConnect = useConnectModal();
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
  const appActions = useMemo<AppActions>(() => ({ openTestFunds: () => setFundsOpen(true), openActivity: () => setActivityOpen(true) }), [setFundsOpen]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tour, setTour] = useState<TourState>("closed");
  const [tourDecided, setTourDecided] = useState(false);

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
      { id: "act-connect", label: wallets.anyConnected ? "Connect another wallet" : "Connect a wallet", group: "Actions", keywords: "near evm solana demo", run: () => openConnect() },
      { id: "act-funds", label: "Get test funds", group: "Actions", keywords: "faucet tusdc eth sol mint", run: () => setFundsOpen(true) },
      { id: "act-activity", label: "Open the activity feed", group: "Actions", keywords: "events history", run: () => setActivityOpen(true) },
      { id: "act-tour", label: "Replay the guided tour", group: "Help", keywords: "onboarding help", run: () => setTour("requested") },
      { id: "act-refresh", label: "Refresh balances", group: "Actions", run: () => void wallets.refreshBalances() },
      ...(demo ? [{ id: "help-demo", label: "Watch a full round (guided demo)", group: "Help" as const, keywords: "demo walkthrough seeded tour video", run: () => router.push(ROUTES.demo) }] : []),
    ],
    [demo, openConnect, router, setFundsOpen, wallets],
  );
  /** The activity and palette buttons hide below `sm` / `lg`; the mobile menu carries both (a phone has no Cmd+K). */
  const menuActions = useMemo<MenuAction[]>(
    () => [
      { id: "activity", label: "Activity", hint: "engine events", onSelect: () => setActivityOpen(true) },
      { id: "palette", label: "Search and commands", hint: "pages, actions", onSelect: () => setPaletteOpen(true) },
    ],
    [],
  );

  return (
    <AppActionsProvider value={appActions}>
      <div className="flex min-h-dvh flex-col">
        <TopNav
          menuActions={menuActions}
          action={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActivityOpen(true)}
                aria-label="Open activity feed"
                title="Activity"
                data-activity
                data-variant="secondary"
                className="ui-block hidden size-8 items-center justify-center rounded-md sm:flex"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 7v5l3 2" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                title="Command palette (⌘K)"
                aria-label="Open the command palette"
                data-palette
                className="ui-field hidden h-8 items-center gap-2 px-2 text-[12px] text-ink-400 transition-colors hover:text-ink-100 md:flex lg:w-48"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <span className="hidden lg:inline">Search</span>
                <Kbd className="lg:ml-auto">⌘K</Kbd>
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
              openConnect(chain);
            }}
          />
        ) : (
          <FundsLoading open={fundsOpen} failed={fundsFailed} onClose={() => setFundsOpen(false)} onRetry={loadFundsPanel} />
        )}
        <ActivityFeedDrawer open={activityOpen} onClose={() => setActivityOpen(false)} />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
        <GuidedTour open={tourVisible(tour, onDemo)} onClose={() => setTour("closed")} deciding={!tourDecided} />
      </div>
    </AppActionsProvider>
  );
}
