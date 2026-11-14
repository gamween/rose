"use client";

import { useCallback, useState, type ComponentType } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useConnectModal } from "@/components/wallet/ConnectModal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { WalletsStatusRow } from "@/components/wallet/WalletsStatus";
import { deployed } from "@/lib/deployment";
import { addressUrl } from "@/lib/explorer";
import { useEngineQuery } from "@/lib/use-engine-query";
import { ClaimDialog, type ClaimPrompt } from "./ClaimDialog";
import type { PortfolioData } from "./data";
import { FlowDialog, type FlowRequest } from "./FlowDialog";
import { GettingStarted } from "./GettingStarted";
import type { PortfolioAccountProps } from "./PortfolioAccount";

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
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink-50">Portfolio</h1>
          <p className="mt-1 text-[13px] text-ink-400 [overflow-wrap:anywhere]">
            {account ? (
              <a href={addressUrl("near", account)} target="_blank" rel="noreferrer" className="font-mono text-ink-200 underline-offset-2 hover:underline">
                {account}
              </a>
            ) : (
              "Your units, claims and sealed orders."
            )}{" "}
            <LearnMore topic="wallets" label="Holder guide" />
          </p>
        </div>
        {account && engine ? (
          <Button size="sm" variant="secondary" onClick={refreshAll} loading={refreshing} loadingLabel="Refreshing" data-portfolio-refresh>
            Refresh
          </Button>
        ) : null}
      </header>

      {!engine ? (
        <EmptyState illustration="ledger" title="Engine not deployed yet" description="The portfolio fills in once NEXT_PUBLIC_ENGINE_ACCOUNT points to a deployed engine." />
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
      <ClaimDialog prompt={prompt} onClose={() => setPrompt(null)} />
      <FlowDialog request={flow} onClose={() => setFlow(null)} onDone={refreshAll} />
    </div>
  );
}
