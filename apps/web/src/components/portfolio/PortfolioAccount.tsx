"use client";

/**
 * The connected part of `/app` (spec 8.3 "Portfolio"): stats, holdings, claims, orders, liens,
 * history and storage of one NEAR account, with every claim, redeem and payout flow. It reads
 * Base and Solana through the chain SDKs, so `PortfolioPage` downloads it with the account data.
 */

import { type PayoutView } from "@rose/sdk";
import { useMemo } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatAmount, formatUsdc, venueLabel } from "@/lib/amounts";
import { deployed } from "@/lib/deployment";
import { requireEngine } from "@/lib/engine-client";
import { txLinks } from "@/lib/explorer";
import { classLabel } from "@/lib/token-symbols";
import { useAction } from "@/lib/use-action";
import type { ClaimPrompt } from "./ClaimDialog";
import { ClaimsSection } from "./ClaimsSection";
import type { PortfolioData } from "./data";
import type { FlowRequest } from "./FlowDialog";
import { claimBaseTokensSteps, claimSolTokensSteps, confirmPayoutSteps, finishPayoutSteps, redeemSteps, resignGasSteps, retryBaseSignatureSteps, retrySolPayoutSteps, withdrawBaseCashSteps, withdrawNearCashSteps, type FlowDeps } from "./flows";
import { HistorySection, StorageSection } from "./HistoryAndStorage";
import { HoldingsSection } from "./HoldingsSection";
import { LiensSection, OrdersSection } from "./OrdersAndLiens";
import { cashRows, holdingRows, lienProgress, orderRows, tokenClaims, type CashRow, type HoldingRow, type TokenClaim } from "./transforms";

export { fetchPortfolioData } from "./data";

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
    };
  };

  const claimCash = (row: CashRow) => {
    const venue = row.cash.venue;
    if (venue === "Near") {
      setPrompt({
        title: "Claim NEAR tUSDC",
        description: "Pulls tUSDC from your engine cash balance to your NEAR account (ft_transfer).",
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
  );
}
