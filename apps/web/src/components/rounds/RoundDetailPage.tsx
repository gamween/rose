"use client";

/**
 * `/app/rounds/[id]` (spec 8.3 Round detail): public parameters, status timeline with the next
 * action, sealed book, order form, my orders, and after the close the key release, opening
 * progress, curves animating into the clearing price, fills, settlement links and Verify.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { CardTitle } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Term } from "@/components/ui/Term";
import { cn } from "@/lib/cn";
import { nearAccountUrl } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";
import { ClearingChart } from "./ClearingChart";
import { buildBook, roundCurves } from "./curves";
import { FillsTable } from "./FillsTable";
import { FinalizePanel } from "./FinalizePanel";
import { classLabel, clearingOf, formatDuration, formatQty, formatUsdc, KIND_BLURB, lockedPercent, nsToMs, shortAccount, venueLabel, venueTokenAccount } from "./model";
import { MyOrders } from "./MyOrders";
import { OrderForm } from "./OrderForm";
import { SealedBook } from "./SealedBook";
import { SettlementPanel } from "./SettlementPanel";
import { DateTimeText, ErrorState, KindBadge, NotDeployedState, Param, StatusBadge } from "./shared";
import { StatusTimeline } from "./StatusTimeline";
import { useRoundDetail, type RoundDetail } from "./useRoundDetail";
import { VerifyPanel } from "./VerifyPanel";

function Parameters({ detail }: { detail: RoundDetail }) {
  const { round, cls, symbol } = detail;
  return (
    <section aria-label="Public parameters" className="ui-surface rounded-lg px-4 py-3" data-parameters>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-6">
        <Param label={<Term term="class" align="start">Class</Term>} mono={false} className="sm:col-span-2">
          <span title={`Token ${cls.token} on ${cls.chain}`}>{classLabel(cls, symbol)}</span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-ink-400" title={cls.classId}>
            <span className="min-w-0 truncate">{cls.classId}</span>
            <CopyButton value={cls.classId} label="Copy the class id" />
          </span>
        </Param>
        <Param label={<Term term="cashVenue">Cash venue</Term>} mono={false}>
          <span title={venueTokenAccount(round.venue)}>{venueLabel(round.venue)}</span>
        </Param>
        <Param label={<Term term="maxPrice">Max price</Term>}>{formatUsdc(round.maxPrice)} USDC</Param>
        <Param label={<Term term="lockedFraction">Locked at close</Term>}>
          {lockedPercent(round.fTs)}
          <span className="block text-[11px] text-ink-400">f(ts) per unit · {formatDuration(Number(round.remainingLockSecs))} left</span>
        </Param>
        <Param label="Creator" mono={false}>
          <a href={nearAccountUrl(round.creator)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline" title={round.creator}>
            {shortAccount(round.creator)}
          </a>
        </Param>
        {round.kind === "Tender" ? (
          <>
            <Param label="Budget">{formatUsdc(round.budget ?? 0n)} USDC</Param>
            <Param label="Issuer escrow">
              {formatUsdc(round.issuerEscrow ?? 0n)} <span className="text-[11px] text-ink-400">budget + 30 bps</span>
            </Param>
            {round.referencePrice !== null ? <Param label="Declared reference">{formatUsdc(round.referencePrice)} USDC</Param> : null}
            <Param label="Retire to" mono={false}>
              <span className="tabular" title={round.retireTo ?? ""}>
                {round.retireTo ? `${round.retireTo.slice(0, 10)}…` : "—"}
              </span>
            </Param>
          </>
        ) : null}
        {round.kind === "Advance" ? (
          <>
            <Param label="Units encumbered">{formatQty(round.advanceUnits ?? 0n, cls.decimals)}</Param>
            <Param label="Claim (K)">{formatQty(round.advanceClaim ?? 0n, cls.decimals)} tokens</Param>
            <Param label="Minimum fill">{formatQty(round.advanceMinFill ?? 0n, cls.decimals)}</Param>
            {round.lienId !== null ? <Param label="Lien">#{round.lienId.toString()}</Param> : null}
          </>
        ) : null}
        {round.kind !== "Tender" && round.maxBuyQuantity !== null && round.maxBuyQuantity !== undefined ? <Param label="Largest bid quantity">{formatQty(round.maxBuyQuantity, cls.decimals)}{round.kind === "Advance" ? " tokens" : ""}</Param> : null}
        <Param label="Opens">
          <DateTimeText ms={nsToMs(round.opensAt)} />
        </Param>
        <Param label="Closes">
          <DateTimeText ms={nsToMs(round.closesAt)} />
        </Param>
        <Param label="Identity (app_id)">
          <span title={round.appId}>{round.appId.slice(0, 16)}…</span>
        </Param>
        <Param label="Limits">
          {String(round.bidCount)} / {String(detail.limits.maxBidsPerRound)} orders
        </Param>
      </dl>
    </section>
  );
}

function Curves({ detail }: { detail: RoundDetail }) {
  const { round, bids, cls } = detail;
  const book = useMemo(() => buildBook(round, bids), [bids, round]);
  const curves = useMemo(() => roundCurves(round, cls.decimals, book), [book, cls.decimals, round]);
  const opened = bids.filter((bid) => bid.opened !== null).length;
  if (opened === 0) return null;
  const result = clearingOf(round);
  const clearing = result ? { price: result.price, volume: result.volume } : null;
  const noCrossing = round.status === "Cancelled" && round.cancelReason === "NoCrossing";
  return (
    <section aria-label="Supply and demand" className="ui-surface rounded-lg" data-curves>
      <div className="border-b border-ink-750 px-4 py-3">
        <CardTitle>Supply and demand</CardTitle>
        <p className="mt-1 text-[12px] leading-snug text-ink-400">
          {clearing ? `Cleared where the curves meet, at ${formatUsdc(clearing.price)} USDC.` : noCrossing ? "The curves never meet: no price trades a positive volume." : `${String(opened)} of ${String(bids.length)} orders are open; the curves firm up as the book opens.`}
        </p>
      </div>
      <div className="p-4">
        <ClearingChart curves={curves} decimals={cls.decimals} kind={round.kind} clearing={clearing} noCrossing={noCrossing} />
      </div>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-40 w-full rounded-lg" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </div>
  );
}

export function RoundDetailPage({ roundId, configured }: { roundId: string; configured: boolean }) {
  const id = useMemo(() => (/^\d+$/.test(roundId) ? BigInt(roundId) : null), [roundId]);
  if (!configured) {
    return (
      <div className="flex flex-col gap-4">
        <Crumbs roundId={roundId} />
        <NotDeployedState />
      </div>
    );
  }
  if (id === null) {
    return (
      <div className="flex flex-col gap-4">
        <Crumbs roundId={roundId} />
        <EmptyState illustration="ledger" title="Not a round id" description={`"${roundId}" is not a round number. Round ids are the integers the engine assigns at creation.`} action={<ButtonLink href={ROUTES.rounds} size="sm" variant="secondary">All rounds</ButtonLink>} />
      </div>
    );
  }
  return <LoadedRound id={id} />;
}

function Crumbs({ roundId }: { roundId: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[12px] text-ink-400">
      <Link href={ROUTES.rounds} className="transition-colors hover:text-ink-100">
        Rounds
      </Link>
      <span aria-hidden className="text-ink-600">/</span>
      <span className="text-ink-200">#{roundId}</span>
    </nav>
  );
}

function LoadedRound({ id }: { id: bigint }) {
  const { state, refresh, retry, refreshing } = useRoundDetail(id);
  const [now, setNow] = useState(() => Date.now());
  const [finalizeRequested, setFinalizeRequested] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const changed = refresh;
  const requestFinalize = useCallback(() => {
    setFinalizeRequested(true);
    document.querySelector("[data-finalize]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const requestSettle = useCallback(() => {
    document.querySelector("[data-fills], [data-my-orders]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (state.status === "loading") return <DetailSkeleton />;
  if (state.status === "not_deployed") {
    return (
      <div className="flex flex-col gap-4">
        <Crumbs roundId={id.toString()} />
        <NotDeployedState detail={state.detail} />
      </div>
    );
  }
  if (state.status === "error") {
    const notFound = state.message.startsWith("Round #") && state.message.includes("does not exist");
    return (
      <div className="flex flex-col gap-4">
        <Crumbs roundId={id.toString()} />
        {notFound ? (
          <EmptyState illustration="ledger" title={`Round #${id.toString()} does not exist`} description="The engine has no round with this id. It may not have been created yet, or the link points at another deployment." action={<ButtonLink href={ROUTES.rounds} size="sm" variant="secondary">All rounds</ButtonLink>} />
        ) : (
          <ErrorState message={state.message} onRetry={retry} />
        )}
      </div>
    );
  }
  const detail = state.value;
  const { round, cls, symbol } = detail;
  const clockMs = now;
  const terminal = round.status === "Settled" || round.status === "Cancelled";
  const bidding = round.status === "Open" || round.status === "Scheduled";

  return (
    <div className="flex flex-col gap-4" data-round-detail={round.roundId.toString()} data-round-status={round.status}>
      <Crumbs roundId={round.roundId.toString()} />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[24px] font-semibold tracking-tight text-ink-50">Round #{round.roundId.toString()}</h1>
            <KindBadge kind={round.kind} />
            <StatusBadge status={round.status} />
            {round.cancelReason ? <span className="text-[11px] text-danger-400 font-medium">{round.cancelReason === "NoCrossing" ? "no crossing" : round.cancelReason === "NoKey" ? "no key" : round.cancelReason === "Empty" ? "no orders" : "withdrawn"}</span> : null}
          </div>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-400">
            {KIND_BLURB[round.kind]} {symbol ? `Class ${symbol} on ${cls.chain}.` : ""} <LearnMore topic="sealedRounds" />
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={refreshing ? "tabular text-[11px] text-ink-400" : "tabular text-[11px] text-ink-400 opacity-0"} aria-live="polite">
            refreshing…
          </span>
          <Button size="sm" variant="secondary" onClick={refresh} data-refresh>
            Refresh
          </Button>
        </div>
      </header>

      <Parameters detail={detail} />
      <StatusTimeline detail={detail} nowMs={clockMs} onChanged={changed} onFinalize={requestFinalize} onSettle={requestSettle} />
      <FinalizePanel detail={detail} onChanged={changed} autoStart={finalizeRequested} onAutoStarted={() => setFinalizeRequested(false)} />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Curves detail={detail} />
          <FillsTable detail={detail} onChanged={changed} />
          <SealedBook detail={detail} />
          {bidding ? <SettlementPanel detail={detail} /> : null}
        </div>
        {/* While bidding is open the order form stays in view; afterwards the side column holds the verification and payouts. */}
        <div className={cn("flex min-w-0 flex-col gap-4", bidding && "lg:sticky lg:top-[72px]")}>
          <MyOrders detail={detail} onChanged={changed} />
          {bidding ? <OrderForm detail={detail} nowMs={clockMs} onPlaced={changed} /> : null}
          {terminal || round.status === "Clearing" || round.status === "Revealing" ? <VerifyPanel detail={detail} /> : null}
          {bidding ? null : <SettlementPanel detail={detail} />}
        </div>
      </div>
    </div>
  );
}
