"use client";

/**
 * The connected part of `/app` (spec 8.3 "Portfolio"): stats, holdings, claims, orders, liens,
 * history and storage of one NEAR account, with every claim, redeem and payout flow. It reads
 * Base and Solana through the chain SDKs, so `PortfolioPage` downloads it with the account data.
 */

import { type PayoutView } from "@rose/sdk";
import { useMemo } from "react";
import { GetTestFundsButton } from "@/components/chrome/AppActions";
import { ButtonLink } from "@/components/ui/Button";
import { KeyStats } from "@/components/ui/KeyStats";
import { NextStep } from "@/components/ui/NextStep";
import { TabPanel, Tabs, useTabs, type TabItem } from "@/components/ui/Tabs";
import { useWallets } from "@/components/wallet/WalletProvider";
import { cashDecimalsOf, formatAmount, formatUsdc, formatVenueCash, shortHex, venueLabel } from "@/lib/amounts";
import { deployed } from "@/lib/deployment";
import { nearRpc, requireEngine } from "@/lib/engine-client";
import { txLinks } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";
import { classLabel } from "@/lib/token-symbols";
import { useAction } from "@/lib/use-action";
import { basePublicClient } from "@/lib/wallet/evm-demo";
import { solanaConnection } from "@/lib/wallet/solana-demo";
import type { ClaimPrompt } from "./ClaimDialog";
import { ClaimsSection } from "./ClaimsSection";
import type { PortfolioData, SolClassView, SolStreamRow } from "./data";
import type { FlowRequest } from "./FlowDialog";
import { claimBaseTokensSteps, claimSolTokensSteps, confirmPayoutSteps, finishPayoutSteps, redeemSteps, resignGasSteps, retryBaseSignatureSteps, retrySolPayoutSteps, syncSolStreamSteps, withdrawBaseCashSteps, withdrawNearCashSteps, type FlowDeps } from "./flows";
import { HOLDER_PATH } from "./GettingStarted";
import { HistorySection, StorageSection } from "./HistoryAndStorage";
import { HoldingsSection } from "./HoldingsSection";
import { LiensSection, OrdersSection } from "./OrdersAndLiens";
import { SolanaStreamsSection } from "./SolanaStreamsSection";
import { cashRows, holdingRows, lienProgress, orderRows, settledPayout, solRedeemNote, solStreamAttention, tokenClaims, type CashRow, type HoldingRow, type TokenClaim } from "./transforms";

type PortfolioTab = "holdings" | "claims" | "orders" | "liens" | "streams" | "history" | "storage";

export { fetchPortfolioData } from "./data";

const SOL_REDEEM_UNAVAILABLE = {
  drawing: "An unconfirmed payout draws on its stream",
  closing: "Its stream ends within 5 minutes",
  ended: "Its stream has ended",
} as const;

/**
 * Solana positions whose stream takes no redeem now (spec 7.3), with the reason, by position id.
 * A held position missing from its class's `get_sol_streams` had its stream pruned: fully
 * withdrawn by payouts, or ended and synced. A stream whose sender switched automatic withdrawal
 * on is refused (`solRedeemSafety`); the redeem flow checks every stream again at finality.
 */
function solRedeemUnavailable(data: PortfolioData): Map<string, string> {
  const reasons = new Map<string, string>();
  const listed = new Set(data.solClasses.flatMap((view) => view.streams.map((row) => row.entry.position_id)));
  const viewed = new Set(data.solClasses.map((view) => view.classId));
  for (const position of data.positions) {
    if (position.source.kind === "SolanaStream" && viewed.has(position.classId) && !listed.has(position.positionId.toString())) reasons.set(position.positionId.toString(), "Its stream is fully withdrawn (ended and synced)");
  }
  for (const row of data.solClasses.flatMap((view) => view.streams)) {
    if (row.phase !== "open") reasons.set(row.entry.position_id, SOL_REDEEM_UNAVAILABLE[row.phase]);
    else if (solStreamAttention(row)?.kind === "automatic_withdrawal") reasons.set(row.entry.position_id, "Its stream withdraws automatically: sync it and claim from the swept balance");
  }
  return reasons;
}

/** Solana positions the redeem syncs first (their stream withdrew more than the engine booked) or whose stream could not be read. */
function solRedeemNotes(data: PortfolioData): Map<string, string> {
  const notes = new Map<string, string>();
  for (const row of data.solClasses.flatMap((view) => view.streams)) {
    const note = solRedeemNote(solStreamAttention(row));
    if (note !== undefined) notes.set(row.entry.position_id, note);
  }
  return notes;
}

/** `setPrompt` and `setFlow` drive the page's claim and flow dialogs, which outlive this view (a running flow keeps its result on screen). */
export type PortfolioAccountProps = { account: string; data: PortfolioData; refreshAll: () => void; setPrompt: (prompt: ClaimPrompt | null) => void; setFlow: (flow: FlowRequest) => void };

export function PortfolioAccount({ account, data, refreshAll, setPrompt, setFlow }: PortfolioAccountProps) {
  const wallets = useWallets();
  const simple = useAction({ onSuccess: refreshAll });

  const rows = useMemo(() => holdingRows(data.portfolio.holdings, data.classes, data.blockTimeSec), [data]);
  const claims = useMemo(() => tokenClaims(data.portfolio.holdings, data.portfolio.lienShares, data.retiredLots, data.classes), [data]);
  const cash = useMemo(() => cashRows(data.portfolio.cash), [data]);
  const orders = useMemo(() => orderRows(data.portfolio.bids), [data]);
  const liens = useMemo(() => lienProgress(data.portfolio.liensHeld), [data]);

  const deps = (): FlowDeps => {
    const { views, calls } = requireEngine();
    return {
      account,
      views,
      calls,
      sendNearCall: wallets.sendNearCall,
      getEvmWalletClient: wallets.getEvmWalletClient,
      getSolanaSigner: wallets.getSolanaSigner,
      vaultSol: data.config.derived_addresses?.vault_sol ?? deployed("solanaVault"),
      base: basePublicClient(),
      solana: solanaConnection(),
      finalBlockHeight: async (signal) => BigInt((await nearRpc().block("final", signal)).header.height),
    };
  };

  const claimCash = (row: CashRow) => {
    const venue = row.cash.venue;
    if (venue === "Near") {
      setPrompt({
        title: "Claim NEAR tUSDC",
        description: "From your engine cash to your NEAR account.",
        amount: { max: row.cash.amount, decimals: 6, unit: "tUSDC" },
        confirmLabel: "Claim",
        onConfirm: ({ amount }) => {
          setPrompt(null);
          setFlow({ title: "Claim NEAR tUSDC", summary: `${formatUsdc(amount)} tUSDC to ${account}`, steps: () => withdrawNearCashSteps(deps(), amount) });
        },
      });
      return;
    }
    const token = venue.Base.token;
    const decimals = cashDecimalsOf(venue, data.cashDecimals);
    setPrompt({
      title: `Claim ${venueLabel(venue, data.symbols)}`,
      description: "From your engine cash to a Base address.",
      details: "The engine debits your cash, the MPC signs a RoseVault Transfer, and you submit executeTransfer from your EVM wallet (you pay the Base gas).",
      amount: { max: row.cash.amount, decimals: decimals ?? 0, unit: decimals === null ? "base units" : (data.symbols.get(token.toLowerCase()) ?? shortHex(token)) },
      destination: { chain: "base", initial: wallets.evm.address ?? "" },
      confirmLabel: "Claim",
      onConfirm: ({ amount, destination }) => {
        setPrompt(null);
        setFlow({ title: `Claim ${venueLabel(venue, data.symbols)}`, summary: `${formatVenueCash(amount, decimals)} to ${destination}`, steps: () => withdrawBaseCashSteps(deps(), token, amount, destination.toLowerCase()) });
      },
    });
  };

  const claimTokens = (claim: TokenClaim) => {
    const chain = claim.info.chain === "Base" ? "base" : "solana";
    const symbol = classLabel(claim.info, data.symbols);
    const fixed = claim.source.kind === "retired" ? claim.source.retireTo : null;
    setPrompt({
      title: `Claim ${symbol} on ${chain === "base" ? "Base Sepolia" : "Solana devnet"}`,
      description: `Unlocked tokens to a ${chain === "base" ? "Base" : "Solana"} address.`,
      details:
        chain === "base"
          ? "RoseVault is filled from the class streams if needed (Sablier withdrawMax, anyone may), the engine debits your claimable balance, the MPC signs a Transfer authorization, and you submit it to RoseVault."
          : "You create the payout's durable nonce and receipt accounts, the engine builds one transaction (the class's swept balance first, Streamflow withdraws into the vault for the rest, the SPL transfer to you, the receipt advance), the MPC signs it and your browser broadcasts it. Fees are paid by the engine's gas/sol address. A stream pays nothing from 5 minutes before its end until its auto-claim is synced (Solana streams).",
      amount: { max: claim.source.amount, decimals: claim.info.decimals, unit: symbol },
      destination: { chain, initial: fixed ?? (chain === "base" ? (wallets.evm.address ?? "") : (wallets.solana.publicKey ?? "")), fixed: fixed !== null },
      confirmLabel: "Claim",
      onConfirm: ({ amount, destination }) => {
        setPrompt(null);
        const source = { ...claim.source, amount };
        setFlow({
          title: `Claim ${formatAmount(amount, claim.info.decimals)} ${symbol}`,
          summary: `${claim.source.label} → ${destination}`,
          steps: () => (chain === "base" ? claimBaseTokensSteps(deps(), source, claim.info.token, claim.info.decimals, destination.toLowerCase()) : claimSolTokensSteps(deps(), source, claim.info.token, claim.info.decimals, destination)),
        });
      },
    });
  };

  const redeem = (row: HoldingRow) => {
    const chain = row.info.chain === "Base" ? "base" : "solana";
    const candidates = data.positions.filter((position) => position.classId === row.info.classId);
    const pendingExcess = data.portfolio.liensHeld.filter((lien) => lien.classId === row.info.classId && !lien.released).reduce((sum, lien) => sum + lien.pendingExcess, 0n);
    const symbol = classLabel(row.info, data.symbols);
    setPrompt({
      title: `Redeem a ${symbol} position in kind`,
      description: "Burn a position's units and take its stream back.",
      details:
        chain === "base"
          ? "Burns the position's allocation from your free units and authorizes a RoseVault Release: the vault withdraws the vested balance to itself first, then the stream NFT is transferred to you."
          : "The app first reads the stream at finality: a stream whose sender switched Streamflow's automatic withdrawal on is not redeemed (sync it and claim from the swept balance instead), and what the stream withdrew beyond the engine's accounting is synced first. The redeem then burns the position's allocation from your free units and pays, from your claimable tokens of the class, what the stream still owes the unit holders (you take its unlocked balance with it). The engine signs transfer_recipient, which moves the stream to you; nothing is withdrawn into the vault.",
      positions: {
        candidates,
        decimals: row.info.decimals,
        freeUnits: row.holding.balance,
        owed: chain === "solana" ? { byPosition: data.redeemOwed, claimable: row.holding.claimable + pendingExcess, unit: symbol } : undefined,
        unavailable: chain === "solana" ? solRedeemUnavailable(data) : undefined,
        notes: chain === "solana" ? solRedeemNotes(data) : undefined,
      },
      destination: { chain, initial: chain === "base" ? (wallets.evm.address ?? "") : (wallets.solana.publicKey ?? "") },
      confirmLabel: "Redeem",
      onConfirm: ({ destination, position }) => {
        if (!position) return;
        setPrompt(null);
        setFlow({ title: `Redeem position #${position.positionId.toString()}`, summary: `${formatAmount(position.allocation, row.info.decimals)} units burned · stream to ${destination}`, steps: () => redeemSteps(deps(), position, chain === "base" ? destination.toLowerCase() : destination, row.info.token, row.info.decimals) });
      },
    });
  };

  const finishPayout = (payout: PayoutView) => setFlow({ title: `Finish payout #${payout.id}`, steps: () => finishPayoutSteps(deps(), payout) });
  const resignGas = (payout: PayoutView) => setFlow({ title: `Re-sign gas for payout #${payout.id}`, steps: () => resignGasSteps(deps(), payout) });
  const retrySignature = (payout: PayoutView) =>
    setFlow({ title: `Retry signature of payout #${payout.id}`, steps: () => (payout.chain === "Base" ? retryBaseSignatureSteps(deps(), payout) : retrySolPayoutSteps(deps(), payout)) });
  const confirmPayout = (payout: PayoutView) => setFlow({ title: `Confirm payout #${payout.id}`, steps: () => confirmPayoutSteps(deps(), payout) });
  const syncStream = (view: SolClassView, row: SolStreamRow) => {
    const info = data.classes.get(view.classId);
    if (!info) return;
    const decimals = info.decimals;
    setFlow({ title: `Sync position #${row.entry.position_id}`, summary: `Streamflow stream ${row.entry.stream.metadata.slice(0, 8)}… → swept balance`, steps: () => syncSolStreamSteps(deps(), row.entry, decimals) });
  };
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

  const openOrders = orders.filter((row) => row.open).length;
  const pendingPayouts = data.payouts.filter((entry) => !settledPayout(entry.state)).length;
  const claimCount = cash.length + claims.base.length + claims.solana.length + pendingPayouts;
  const activeLiens = liens.filter((item) => !item.lien.released).length + data.portfolio.lienShares.length;
  const hasStreams = data.solClasses.some((view) => view.streams.length > 0 || view.swept.balance > 0n);
  const cashDecimals = new Set(cash.map((row) => cashDecimalsOf(row.cash.venue, data.cashDecimals)));
  const sharedDecimals = cashDecimals.size === 1 ? [...cashDecimals][0] : undefined;
  const cashStat =
    cash.length === 0
      ? { value: formatUsdc(0n), unit: "USDC" }
      : cash.length === 1
        ? { value: formatVenueCash(cash[0]!.cash.amount, cashDecimalsOf(cash[0]!.cash.venue, data.cashDecimals)), unit: venueLabel(cash[0]!.cash.venue, data.symbols) }
        : sharedDecimals !== undefined && sharedDecimals !== null
          ? { value: formatVenueCash(cash.reduce((sum, row) => sum + row.cash.amount, 0n), sharedDecimals), unit: "USDC", hint: `across ${String(cash.length)} venues` }
          : { value: `${String(cash.length)} venues` };
  const tabItems: TabItem<PortfolioTab>[] = [
    { id: "holdings", label: "Holdings", count: rows.length },
    { id: "claims", label: "Claims", count: claimCount },
    { id: "orders", label: "Orders", count: openOrders },
    { id: "liens", label: "Liens", count: activeLiens },
    ...(hasStreams ? [{ id: "streams" as const, label: "Solana streams" }] : []),
    { id: "history", label: "History" },
    { id: "storage", label: "Storage" },
  ];
  const tabs = useTabs(
    tabItems.map((item) => item.id),
    claimCount > 0 && rows.length === 0 ? "claims" : "holdings",
    { hash: true },
  );

  /* A demo account the chain says does not exist yet: step 2 comes before any deposit. */
  const needsFunds = wallets.near.kind === "demo" && wallets.near.demoAccount === "missing";

  return (
    <>
      {needsFunds ? (
        <NextStep
          step={{ index: 2, total: HOLDER_PATH.length }}
          title="Get test funds"
          description="Creates your NEAR demo account with test NEAR, then mints tUSDC and a demo position to deposit."
          action={<GetTestFundsButton variant="primary" />}
        />
      ) : rows.length === 0 ? (
        <NextStep
          step={{ index: 3, total: HOLDER_PATH.length }}
          title="Deposit a position to get units"
          description="No position yet? Get test funds in the wallet menu mints a demo one."
          action={
            <ButtonLink href="/app/deposit" size="sm">
              Deposit a position
            </ButtonLink>
          }
        />
      ) : openOrders === 0 ? (
        <NextStep
          step={{ index: 4, total: HOLDER_PATH.length }}
          title="Put your units in a round"
          action={
            <ButtonLink href={ROUTES.rounds} size="sm">
              Browse rounds
            </ButtonLink>
          }
        />
      ) : null}
      <KeyStats
        items={[
          { id: "classes", label: "Classes held", term: "class", value: rows.length },
          { id: "claims", label: "Ready to claim", value: cash.length + claims.base.length + claims.solana.length, hint: pendingPayouts > 0 ? `${String(pendingPayouts)} payout${pendingPayouts === 1 ? "" : "s"} in progress` : undefined },
          { id: "cash", label: "Cash", ...cashStat },
          { id: "orders", label: "Open orders", value: openOrders },
        ]}
      />
      <div className="flex flex-col gap-4">
        <Tabs items={tabItems} value={tabs.value} onChange={tabs.select} idBase={tabs.idBase} label="Portfolio sections" />
        <TabPanel idBase={tabs.idBase} id="holdings" value={tabs.value}>
          <HoldingsSection rows={rows} data={data} onClaim={(row) => claimTokens({ info: row.info, source: { kind: "holding", classId: row.info.classId, amount: row.holding.claimable, label: "Units" } })} onRedeem={redeem} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="claims" value={tabs.value}>
          <ClaimsSection data={data} cash={cash} tokens={claims} actions={{ onClaimCash: claimCash, onClaimTokens: claimTokens, onFinishPayout: finishPayout, onResignGas: resignGas, onRetrySignature: retrySignature, onConfirmPayout: confirmPayout }} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="orders" value={tabs.value}>
          <OrdersSection rows={orders} data={data} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="liens" value={tabs.value}>
          <LiensSection held={liens} data={data} onRelease={releaseLien} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="streams" value={tabs.value}>
          <SolanaStreamsSection data={data} onSync={syncStream} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="history" value={tabs.value}>
          <HistorySection data={data} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="storage" value={tabs.value}>
          <StorageSection data={data} onDeposit={storageDeposit} onWithdraw={storageWithdraw} busy={simple.state.status === "loading"} />
        </TabPanel>
      </div>
    </>
  );
}
