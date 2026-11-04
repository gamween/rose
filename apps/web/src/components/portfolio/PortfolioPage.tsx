"use client";

import { type PayoutView } from "@rose/sdk";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import { ConnectModal } from "@/components/wallet/ConnectModal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatAmount, formatUsdc, venueLabel } from "@/lib/amounts";
import { deployed } from "@/lib/deployment";
import { requireEngine } from "@/lib/engine-client";
import { addressUrl, CHAIN_LABEL, shortAddress, txLinks, type ChainId } from "@/lib/explorer";
import { formatUnits } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { useAction } from "@/lib/use-action";
import { useEngineQuery } from "@/lib/use-engine-query";
import { ClaimDialog, type ClaimPrompt } from "./ClaimDialog";
import { ClaimsSection } from "./ClaimsSection";
import { fetchPortfolioData, classLabel } from "./data";
import { FlowDialog, type FlowRequest } from "./FlowDialog";
import { claimBaseTokensSteps, claimSolTokensSteps, confirmPayoutSteps, finishPayoutSteps, redeemSteps, resignGasSteps, retryBaseSignatureSteps, retrySolPayoutSteps, withdrawBaseCashSteps, withdrawNearCashSteps, type FlowDeps } from "./flows";
import { HistorySection, StorageSection } from "./HistoryAndStorage";
import { HoldingsSection } from "./HoldingsSection";
import { LiensSection, OrdersSection } from "./OrdersAndLiens";
import { cashRows, holdingRows, lienProgress, orderRows, tokenClaims, type CashRow, type HoldingRow, type TokenClaim } from "./transforms";

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
        <li key={entry.chain} className="flex items-center justify-between gap-3 rounded-md border border-ink-750 bg-ink-850 px-3 py-2">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-display text-[11px] uppercase tracking-wide text-ink-300">
              {CHAIN_LABEL[entry.chain]}
              {entry.kind === "demo" ? <Badge tone="ember">Demo</Badge> : null}
            </p>
            {entry.address ? (
              <a href={addressUrl(entry.chain, entry.address)} target="_blank" rel="noreferrer" className="tabular block truncate text-[12px] text-ink-100 underline-offset-2 hover:underline" title={entry.address}>
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
      <h2 className="mb-3 font-display text-[11px] uppercase tracking-wide text-ink-400">Sections</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {SECTIONS.map((section) => (
          <li key={section.href}>
            <Link href={section.href} className="flex h-full flex-col gap-1 rounded-lg border border-ink-750 bg-ink-850 px-4 py-3 transition-colors hover:border-ink-500 hover:bg-ink-800">
              <span className="font-display text-[13px] text-ink-50">{section.title}</span>
              <span className="text-[12px] text-ink-400">{section.body}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

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
  const [connect, setConnect] = useState<ChainId | null>(null);
  const [prompt, setPrompt] = useState<ClaimPrompt | null>(null);
  const [flow, setFlow] = useState<FlowRequest | null>(null);

  const fetcher = useCallback((signal: AbortSignal) => fetchPortfolioData(account ?? "", signal), [account]);
  const { state, refresh, refreshing } = useEngineQuery(fetcher, { enabled: account !== null && engine !== null });
  const refreshAll = useCallback(() => {
    void refresh();
    void wallets.refreshBalances();
  }, [refresh, wallets]);
  const simple = useAction({ onSuccess: refreshAll });

  const data = state.status === "ok" ? state.value : null;
  const rows = useMemo(() => (data ? holdingRows(data.portfolio.holdings, data.classes, data.blockTimeSec) : []), [data]);
  const claims = useMemo(() => (data ? tokenClaims(data.portfolio.holdings, data.portfolio.lienShares, data.retiredLots, data.classes) : { base: [], solana: [] }), [data]);
  const cash = useMemo(() => (data ? cashRows(data.portfolio.cash) : []), [data]);
  const orders = useMemo(() => (data ? orderRows(data.portfolio.bids) : []), [data]);
  const liens = useMemo(() => (data ? lienProgress(data.portfolio.liensHeld) : []), [data]);

  const deps = (): FlowDeps => {
    const { views, calls } = requireEngine();
    return {
      account: account ?? "",
      views,
      calls,
      sendNearCall: wallets.sendNearCall,
      getEvmWalletClient: wallets.getEvmWalletClient,
      getSolanaSigner: wallets.getSolanaSigner,
      vaultSol: data?.config.derived_addresses?.vault_sol ?? deployed("solanaVault"),
    };
  };

  const claimCash = (row: CashRow) => {
    if (!data) return;
    const venue = row.cash.venue;
    if (venue === "Near") {
      setPrompt({
        title: "Claim NEAR tUSDC",
        description: "Pulls tUSDC from your engine cash balance to your NEAR account (ft_transfer).",
        amount: { max: row.cash.amount, decimals: 6, unit: "tUSDC" },
        confirmLabel: "Claim",
        onConfirm: ({ amount }) => {
          setPrompt(null);
          setFlow({ title: "Claim NEAR tUSDC", summary: `${formatUsdc(amount)} tUSDC to ${account ?? ""}`, steps: () => withdrawNearCashSteps(deps(), amount) });
        },
      });
      return;
    }
    const token = venue.Base.token;
    setPrompt({
      title: `Claim ${venueLabel(venue, data.symbols)}`,
      description: "The engine debits your cash, the MPC signs a RoseVault Transfer, and you submit executeTransfer from your EVM wallet (you pay the Base gas).",
      amount: { max: row.cash.amount, decimals: 6, unit: data.symbols.get(token.toLowerCase()) ?? "USDC" },
      destination: { chain: "base", initial: wallets.evm.address ?? "" },
      confirmLabel: "Claim",
      onConfirm: ({ amount, destination }) => {
        setPrompt(null);
        setFlow({ title: `Claim ${venueLabel(venue, data.symbols)}`, summary: `${formatUsdc(amount)} to ${destination}`, steps: () => withdrawBaseCashSteps(deps(), token, amount, destination.toLowerCase()) });
      },
    });
  };

  const claimTokens = (claim: TokenClaim) => {
    if (!data) return;
    const chain = claim.info.chain === "Base" ? "base" : "solana";
    const symbol = classLabel(claim.info, data.symbols);
    const fixed = claim.source.kind === "retired" ? claim.source.retireTo : null;
    setPrompt({
      title: `Claim ${symbol} on ${chain === "base" ? "Base Sepolia" : "Solana devnet"}`,
      description:
        chain === "base"
          ? "RoseVault is filled from the class streams if needed (Sablier withdrawMax, anyone may), the engine debits your claimable balance, the MPC signs a Transfer authorization, and you submit it to RoseVault."
          : "You create the payout's durable nonce account, the engine builds one transaction (Streamflow withdraws into the vault plus the SPL transfer to you), the MPC signs it and your browser broadcasts it. Fees are paid by the engine's gas/sol address.",
      amount: { max: claim.source.amount, decimals: claim.info.decimals, unit: symbol },
      destination: { chain, initial: fixed ?? (chain === "base" ? (wallets.evm.address ?? "") : (wallets.solana.publicKey ?? "")), fixed: fixed !== null },
      confirmLabel: "Claim",
      onConfirm: ({ amount, destination }) => {
        setPrompt(null);
        const source = { ...claim.source, amount };
        setFlow({
          title: `Claim ${formatAmount(amount, claim.info.decimals)} ${symbol}`,
          summary: `${claim.source.label} → ${destination}`,
          steps: () => (chain === "base" ? claimBaseTokensSteps(deps(), source, claim.info.token, claim.info.decimals, data.positions, destination.toLowerCase()) : claimSolTokensSteps(deps(), source, claim.info.token, claim.info.decimals, destination)),
        });
      },
    });
  };

  const redeem = (row: HoldingRow) => {
    if (!data) return;
    const chain = row.info.chain === "Base" ? "base" : "solana";
    const candidates = data.positions.filter((position) => position.classId === row.info.classId);
    setPrompt({
      title: `Redeem a ${classLabel(row.info, data.symbols)} position in kind`,
      description:
        chain === "base"
          ? "Burns the position's allocation from your free units and authorizes a RoseVault Release: the vault withdraws the vested balance to itself first, then the stream NFT is transferred to you."
          : "Burns the position's allocation from your free units; the engine withdraws the stream's unlocked balance into the vault (it belongs to the other unit holders), then transfer_recipient moves the stream to you.",
      positions: { candidates, decimals: row.info.decimals, freeUnits: row.holding.balance },
      destination: { chain, initial: chain === "base" ? (wallets.evm.address ?? "") : (wallets.solana.publicKey ?? "") },
      confirmLabel: "Redeem",
      onConfirm: ({ destination, position }) => {
        if (!position) return;
        setPrompt(null);
        setFlow({ title: `Redeem position #${position.positionId.toString()}`, summary: `${formatAmount(position.allocation, row.info.decimals)} units burned · stream to ${destination}`, steps: () => redeemSteps(deps(), position, chain === "base" ? destination.toLowerCase() : destination, row.info.token) });
      },
    });
  };

  const finishPayout = (payout: PayoutView) => setFlow({ title: `Finish payout #${payout.id}`, steps: () => finishPayoutSteps(deps(), payout) });
  const resignGas = (payout: PayoutView) => setFlow({ title: `Re-sign gas for payout #${payout.id}`, steps: () => resignGasSteps(deps(), payout) });
  const retrySignature = (payout: PayoutView) =>
    setFlow({ title: `Retry signature of payout #${payout.id}`, steps: () => (payout.chain === "Base" ? retryBaseSignatureSteps(deps(), payout) : retrySolPayoutSteps(deps(), payout)) });
  const confirmPayout = (payout: PayoutView) => setFlow({ title: `Confirm payout #${payout.id}`, steps: () => confirmPayoutSteps(deps(), payout) });
  const releaseLien = (lienId: bigint) =>
    void simple.run(`Releasing lien #${lienId.toString()}`, async () => {
      const outcome = await wallets.sendNearCall(requireEngine().calls.releaseLien(lienId));
      return { message: `Lien #${lienId.toString()} released`, links: txLinks("near", outcome.transaction.hash) };
    });
  const storageDeposit = (amount: bigint) =>
    void simple.run("Depositing storage", async () => {
      const outcome = await wallets.sendNearCall(requireEngine().calls.storageDeposit(amount));
      return { message: `${formatAmount(amount, 24, 5)} NEAR of storage deposited`, links: txLinks("near", outcome.transaction.hash) };
    });
  const storageWithdraw = (amount: bigint | null) =>
    void simple.run("Withdrawing storage", async () => {
      const outcome = await wallets.sendNearCall(requireEngine().calls.storageWithdraw(amount ?? undefined));
      return { message: amount ? `${formatAmount(amount, 24, 5)} NEAR of storage withdrawn` : "Available storage withdrawn", links: txLinks("near", outcome.transaction.hash) };
    });

  const totalClaims = claims.base.length + claims.solana.length;

  return (
    <div className="flex flex-col gap-6" data-portfolio>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] text-ink-50">Portfolio</h1>
          <p className="mt-1 text-[13px] text-ink-400">
            Units per class, unlock timelines, open orders, liens, claims and history of{" "}
            {account ? (
              <a href={addressUrl("near", account)} target="_blank" rel="noreferrer" className="tabular text-ink-100 underline-offset-2 hover:underline">
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
          <Button size="sm" onClick={() => setConnect("near")}>
            {wallets.anyConnected ? "Connect another wallet" : "Connect a wallet"}
          </Button>
        </div>
      </header>
      <WalletStrip onConnect={(chain) => setConnect(chain)} />

      {!engine ? (
        <EmptyState illustration="ledger" title="Engine not deployed yet" description="The portfolio reads the engine's views (holdings, orders, liens, cash, payouts, events). It fills in as soon as NEXT_PUBLIC_ENGINE_ACCOUNT points to a deployed engine." />
      ) : !wallets.hydrated ? (
        <LoadingPortfolio />
      ) : !account ? (
        <EmptyState
          illustration="vault"
          title="Connect a NEAR wallet"
          description="Units, cash and liens live on your NEAR account. Connect a testnet wallet, or create the in-app demo wallet, to see what you hold."
          action={
            <Button onClick={() => setConnect("near")} data-portfolio-connect>
              Connect NEAR
            </Button>
          }
        />
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
      ) : data ? (
        <>
          <Card>
            <CardBody>
              <dl className="grid grid-cols-2 gap-4 md:grid-cols-5" data-portfolio-stats>
                <Stat label="Classes held" value={rows.length} />
                <Stat label="Open orders" value={orders.filter((row) => row.open).length} />
                <Stat label="Liens" value={liens.filter((item) => !item.lien.released).length + data.portfolio.lienShares.length} hint="as holder + as funder" />
                <Stat label="Token claims" value={totalClaims} hint={totalClaims > 0 ? "ready to pull" : "none yet"} />
                <Stat
                  label="Cash"
                  value={cash.length <= 1 ? formatUsdc(cash[0]?.cash.amount ?? 0n) : `${String(cash.length)} venues`}
                  unit={cash.length <= 1 ? "USDC" : undefined}
                  hint={cash.length === 1 ? venueLabel(cash[0]!.cash.venue, data.symbols) : cash.length > 1 ? cash.map((row) => `${formatUsdc(row.cash.amount)} ${venueLabel(row.cash.venue, data.symbols)}`).join(" · ") : "no cash in the engine"}
                />
              </dl>
            </CardBody>
          </Card>
          <HoldingsSection rows={rows} data={data} onClaim={(row) => claimTokens({ info: row.info, source: { kind: "holding", classId: row.info.classId, amount: row.holding.claimable, label: "Units" } })} onRedeem={redeem} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ClaimsSection data={data} cash={cash} tokens={claims} actions={{ onClaimCash: claimCash, onClaimTokens: claimTokens, onFinishPayout: finishPayout, onResignGas: resignGas, onRetrySignature: retrySignature, onConfirmPayout: confirmPayout }} />
            <OrdersSection rows={orders} data={data} />
          </div>
          <LiensSection held={liens} data={data} onRelease={releaseLien} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <HistorySection data={data} />
            <StorageSection data={data} onDeposit={storageDeposit} onWithdraw={storageWithdraw} busy={simple.state.status === "loading"} />
          </div>
        </>
      ) : null}
      <Sections />
      <ConnectModal open={connect !== null} onClose={() => setConnect(null)} initialChain={connect ?? "near"} />
      <ClaimDialog prompt={prompt} onClose={() => setPrompt(null)} />
      <FlowDialog request={flow} onClose={() => setFlow(null)} onDone={refreshAll} />
    </div>
  );
}
