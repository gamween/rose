"use client";

import Link from "next/link";
import { useCallback, useState, type ComponentType } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useConnectModal } from "@/components/wallet/ConnectModal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { WalletsStatusRow } from "@/components/wallet/WalletsStatus";
import { deployed } from "@/lib/deployment";
import { addressUrl, CHAIN_LABEL, shortAddress, type ChainId } from "@/lib/explorer";
import { formatUnits } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { useEngineQuery } from "@/lib/use-engine-query";
import { ClaimDialog, type ClaimPrompt } from "./ClaimDialog";
import type { PortfolioData } from "./data";
import { FlowDialog, type FlowRequest } from "./FlowDialog";
import { GettingStarted } from "./GettingStarted";
import type { PortfolioAccountProps } from "./PortfolioAccount";

const SECTIONS = [
  { href: ROUTES.rounds, title: "Rounds", body: "Tender, Exit and Advance rounds with sealed bids and countdowns." },
  { href: "/app/deposit", title: "Deposit", body: "Bring a Sablier or Streamflow position into custody and mint units." },
  { href: ROUTES.issuer, title: "Issuer console", body: "Create classes, distribute units and launch a Tender." },
  { href: "/app/advance", title: "Advance", body: "Sell a claim on your first unlocks, or fund one." },
  { href: ROUTES.prices, title: "Prices", body: "Clearing prices per class and discount to reference." },
] as const;

function WalletStrip({ onConnect }: { onConnect: (chain: ChainId) => void }) {
  const wallets = useWallets();
  const entries: { chain: ChainId; address: string | null; kind: "external" | "demo" | null; balance: string | null }[] = [
    { chain: "near", address: wallets.near.accountId, kind: wallets.near.kind, balance: wallets.balances.nearYocto === null ? null : `${formatUnits(wallets.balances.nearYocto, 24)} NEAR` },
    { chain: "base", address: wallets.evm.address, kind: wallets.evm.kind, balance: wallets.balances.baseEthWei === null ? null : `${formatUnits(wallets.balances.baseEthWei, 18, 4)} ETH` },
    { chain: "solana", address: wallets.solana.publicKey, kind: wallets.solana.kind, balance: wallets.balances.solLamports === null ? null : `${formatUnits(wallets.balances.solLamports, 9, 3)} SOL` },
  ];
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-wallet-summary>
      {entries.map((entry) => (
        <li key={entry.chain} className="ui-surface flex items-center justify-between gap-3 rounded-md px-3 py-2">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[12px] text-ink-300 font-medium">
              {CHAIN_LABEL[entry.chain]}
              {entry.kind === "demo" ? <Badge tone="ember">Demo</Badge> : null}
            </p>
            {entry.address ? (
              <a href={addressUrl(entry.chain, entry.address)} target="_blank" rel="noreferrer" className="font-mono block truncate text-[12px] text-ink-100 underline-offset-2 hover:underline" title={entry.address}>
                {shortAddress(entry.chain, entry.address)}
              </a>
            ) : (
              <p className="text-[12px] text-ink-400">Not connected</p>
            )}
          </div>
          {entry.address ? (
            <span className="tabular shrink-0 text-[12px] text-ink-300">{entry.balance ?? <Skeleton className="inline-block h-4 w-14 align-middle" />}</span>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => onConnect(entry.chain)}>
              Connect
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Sections() {
  return (
    <section>
      <h2 className="mb-3 text-[12px] text-ink-400 font-medium">Sections</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {SECTIONS.map((section) => (
          <li key={section.href}>
            <Link href={section.href} className="flex h-full flex-col gap-1 ui-surface rounded-lg px-4 py-3 transition-colors hover:border-ink-500 hover:bg-ink-800">
              <span className="text-[13px] text-ink-50 font-semibold">{section.title}</span>
              <span className="text-[12px] text-ink-400">{section.body}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The account's data and the module that renders it: the chain SDKs that module reads with load only for a connected account. */
type LoadedPortfolio = { data: PortfolioData; Account: ComponentType<PortfolioAccountProps> };

function LoadingPortfolio() {
  return (
    <div className="flex flex-col gap-4" aria-busy data-portfolio-loading>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/** `/app`: the full portfolio of the connected NEAR account (spec 8.3 "Portfolio"). */
export function PortfolioPage() {
  const wallets = useWallets();
  const account = wallets.near.accountId;
  const engine = deployed("engineAccount");
  const openConnect = useConnectModal();
  const [prompt, setPrompt] = useState<ClaimPrompt | null>(null);
  const [flow, setFlow] = useState<FlowRequest | null>(null);

  const fetcher = useCallback(async (signal: AbortSignal): Promise<LoadedPortfolio> => {
    const view = await import("./PortfolioAccount");
    return { data: await view.fetchPortfolioData(account ?? "", signal), Account: view.PortfolioAccount };
  }, [account]);
  const { state, refresh, refreshing } = useEngineQuery(fetcher, { enabled: account !== null && engine !== null });
  const refreshAll = useCallback(() => {
    void refresh();
    void wallets.refreshBalances();
  }, [refresh, wallets]);

  return (
    <div className="flex flex-col gap-6" data-portfolio>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-ink-50">Portfolio</h1>
          <p className="mt-1 text-[13px] text-ink-400">
            Units per class, unlock timelines, open orders, liens, claims and history of{" "}
            {account ? (
              <a href={addressUrl("near", account)} target="_blank" rel="noreferrer" className="font-mono text-ink-100 underline-offset-2 hover:underline">
                {account}
              </a>
            ) : (
              "your NEAR account"
            )}
            . {engine ? "" : "The engine is not deployed yet; units and rounds appear here once it is. "}
            <LearnMore topic="wallets" label="Holder guide" />
          </p>
        </div>
        <div className="flex items-center gap-2">
          {account && engine ? (
            <Button size="sm" variant="secondary" onClick={refreshAll} loading={refreshing} loadingLabel="Refreshing" data-portfolio-refresh>
              Refresh
            </Button>
          ) : null}
          <Button size="sm" variant={account ? "primary" : "secondary"} onClick={() => openConnect()}>
            {wallets.anyConnected ? "Connect another wallet" : "Connect a wallet"}
          </Button>
        </div>
      </header>
      <WalletStrip onConnect={openConnect} />

      {!engine ? (
        <EmptyState illustration="ledger" title="Engine not deployed yet" description="The portfolio reads the engine's views (holdings, orders, liens, cash, payouts, events). It fills in as soon as NEXT_PUBLIC_ENGINE_ACCOUNT points to a deployed engine." />
      ) : !wallets.hydrated ? (
        <LoadingPortfolio />
      ) : !account && wallets.walletsStatus === "failed" ? (
        <WalletsStatusRow what="Restoring your wallet…" />
      ) : !account ? (
        <GettingStarted onConnect={() => openConnect("near")} />
      ) : state.status === "loading" ? (
        <LoadingPortfolio />
      ) : state.status === "not_deployed" ? (
        <EmptyState illustration="ledger" title="Engine not reachable" description={state.detail} />
      ) : state.status === "error" ? (
        <EmptyState
          illustration="ember"
          title="Could not read the portfolio"
          description={state.message}
          action={
            <Button variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        />
      ) : account && state.status === "ok" ? (
        <state.value.Account account={account} data={state.value.data} refreshAll={refreshAll} setPrompt={setPrompt} setFlow={setFlow} />
      ) : null}
      <Sections />
      <ClaimDialog prompt={prompt} onClose={() => setPrompt(null)} />
      <FlowDialog request={flow} onClose={() => setFlow(null)} onDone={refreshAll} />
    </div>
  );
}
