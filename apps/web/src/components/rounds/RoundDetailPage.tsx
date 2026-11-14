"use client";

/**
 * `/app/rounds/[id]` (spec 8.3 Round detail), laid out like a launchpad sale page: a header with
 * the class, status, countdown, four key numbers and the round's progress; one action card on the
 * right (the order form while bidding, then the next lifecycle step); everything else in tabs, one
 * at a time: Overview (timeline), the sealed book, Results (curves, fills, Verify), My orders, and
 * Details (every parameter, the round key, settlement and payout links).
 */

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { ActionLayout } from "@/components/ui/ActionCard";
import { CardTitle } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { EmptyState } from "@/components/ui/EmptyState";
import { KeyStats, type KeyStat } from "@/components/ui/KeyStats";
import { Skeleton } from "@/components/ui/Skeleton";
import { TabPanel, Tabs, useTabs, type TabItem } from "@/components/ui/Tabs";
import { ROUTES } from "@/lib/routes";
import { ClearingChart } from "./ClearingChart";
import { buildBook, roundCurves } from "./curves";
import { FillsTable } from "./FillsTable";
import { FinalizePanel } from "./FinalizePanel";
import { classShortLabel, clearingOf, formatDate, formatQty, formatUsdc, KIND_BLURB, lockedPercent, msToNs, nextAction, nsToMs, scheduleEndSecs, venueLabel } from "./model";
import { MyOrders } from "./MyOrders";
import { OrderForm } from "./OrderForm";
import { RoundAction, RoundExtraActions } from "./RoundAction";
import { RoundDetails } from "./RoundDetails";
import { SealedBook } from "./SealedBook";
import { DateTimeText, ErrorState, KindBadge, NotDeployedState, StatusBadge } from "./shared";
import { RoundProgress, StatusTimeline } from "./StatusTimeline";
import { useRoundDetail, type RoundDetail } from "./useRoundDetail";
import { VerifyPanel } from "./VerifyPanel";

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
    <div className="flex flex-col gap-5" aria-busy>
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-20 w-full rounded-lg" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
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

type TabId = "overview" | "book" | "results" | "mine" | "details";

/** The big clock of the header: what the round is waiting for, and how long. */
function RoundClock({ detail, nowMs }: { detail: RoundDetail; nowMs: number }) {
  const { round } = detail;
  const action = nextAction(round, nowMs);
  let label: string;
  let value: ReactNode;
  switch (action.kind) {
    case "wait_open":
      label = "Opens in";
      value = <Countdown target={action.at} endedLabel="now" />;
      break;
    case "bid":
      label = "Closes in";
      value = <Countdown target={action.closesAt} endedLabel="now" />;
      break;
    case "waiting_key":
      label = "Key requested, arrives in";
      value = "about 5 s";
      break;
    case "finalize":
    case "wait_reveal":
      label = "Reveal window ends in";
      value = <Countdown target={action.until} endedLabel="now" />;
      break;
    default:
      label = round.status === "Cancelled" ? "Cancelled" : round.status === "Settled" ? "Ended" : "Closed";
      value = <DateTimeText ms={nsToMs(round.endedAt ?? round.closesAt)} />;
  }
  return (
    <div className="flex flex-col sm:items-end" data-round-clock>
      <span className="text-[12px] text-ink-400" data-next-action={action.kind === "bid" || action.kind === "wait_open" ? action.kind : undefined}>
        {label}
      </span>
      <span className="tabular text-[26px] leading-tight tracking-tight text-ink-50">{value}</span>
    </div>
  );
}

/** The four numbers of the header: the result once cleared, the book and its bounds before. */
function roundStats(detail: RoundDetail): KeyStat[] {
  const { round, bids, cls } = detail;
  const clearing = clearingOf(round);
  const buys = bids.filter((bid) => bid.side === "Buy").length;
  const orders: KeyStat = { id: "orders", label: round.status === "Open" || round.status === "Scheduled" ? "Sealed orders" : "Orders", value: String(bids.length), hint: `${String(buys)} ${buys === 1 ? "bid" : "bids"}, ${String(bids.length - buys)} ${bids.length - buys === 1 ? "ask" : "asks"}` };
  const maxPrice: KeyStat = { id: "max-price", label: "Max price", term: "maxPrice", value: formatUsdc(round.maxPrice), unit: "USDC" };
  if (clearing) {
    return [
      { id: "clearing", label: "Clearing price", term: "clearingPrice", value: formatUsdc(clearing.price), unit: "USDC" },
      { id: "volume", label: "Volume", value: formatQty(clearing.volume, cls.decimals), unit: round.kind === "Advance" ? "tokens" : "units" },
      orders,
      maxPrice,
    ];
  }
  const third: KeyStat =
    round.kind === "Tender"
      ? { id: "budget", label: "Budget", value: formatUsdc(round.budget ?? 0n), unit: "USDC" }
      : round.kind === "Advance"
        ? { id: "claim", label: "Claim on offer", term: "advance", value: formatQty(round.advanceClaim ?? 0n, cls.decimals), unit: "tokens" }
        : { id: "escrowed", label: "Cash escrowed", term: "escrow", value: formatUsdc(bids.filter((bid) => bid.side === "Buy").reduce((sum, bid) => sum + bid.escrow, 0n)), unit: "USDC" };
  return [maxPrice, orders, third, { id: "locked", label: "Locked at close", term: "lockedFraction", value: lockedPercent(round.fTs) }];
}

function RoundHeader({ detail, nowMs, refreshing, onRefresh }: { detail: RoundDetail; nowMs: number; refreshing: boolean; onRefresh: () => void }) {
  const { round, cls, symbol } = detail;
  return (
    <header className="flex flex-col gap-4">
      <Crumbs roundId={round.roundId.toString()} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[24px] font-semibold tracking-tight text-ink-50">Round #{round.roundId.toString()}</h1>
            <KindBadge kind={round.kind} />
            <StatusBadge status={round.status} closed={round.status === "Open" && msToNs(nowMs) >= round.closesAt} />
            {round.cancelReason ? <span className="text-[11px] text-danger-400 font-medium">{round.cancelReason === "NoCrossing" ? "no crossing" : round.cancelReason === "NoKey" ? "no key" : round.cancelReason === "Empty" ? "no orders" : "withdrawn"}</span> : null}
          </div>
          <p className="mt-1 text-[13px] text-ink-300">
            {classShortLabel(cls, symbol)} · unlocks until {formatDate(scheduleEndSecs(cls) * 1000)} · cash {venueLabel(round.venue)}
          </p>
        </div>
        <div className="flex items-end justify-between gap-4 sm:justify-end">
          <RoundClock detail={detail} nowMs={nowMs} />
          <Button size="sm" variant="ghost" onClick={onRefresh} loading={refreshing} loadingLabel="Refreshing" data-refresh>
            Refresh
          </Button>
        </div>
      </div>
      <KeyStats items={roundStats(detail)} />
      <RoundProgress detail={detail} nowMs={nowMs} />
    </header>
  );
}

function LoadedRound({ id }: { id: bigint }) {
  const { state, refresh, retry, refreshing } = useRoundDetail(id);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const detail = state.status === "ok" ? state.value : null;
  const round = detail?.round ?? null;
  const mine = detail && detail.viewer ? detail.bids.filter((bid) => bid.bidder === detail.viewer?.account) : [];
  const opened = detail ? detail.bids.filter((bid) => bid.opened !== null).length : 0;
  const hasResults = round !== null && (round.status === "Revealing" || round.status === "Clearing" || round.status === "Settled" || round.status === "Cancelled");
  const unsettledMine = mine.some((bid) => bid.status !== "Settled");
  const tabIds = useMemo<TabId[]>(() => ["overview", "book", ...(hasResults ? (["results"] as const) : []), ...(mine.length > 0 ? (["mine"] as const) : []), "details"], [hasResults, mine.length]);
  const fallback: TabId =
    round === null || round.status === "Scheduled"
      ? "overview"
      : round.status === "Settled" || round.status === "Cancelled"
        ? unsettledMine
          ? "mine"
          : "results"
        : round.status === "Clearing"
          ? "results"
          : "book";
  const tabs = useTabs(tabIds, fallback, { hash: true });

  if (state.status === "loading") return <DetailSkeleton />;
  if (state.status === "not_deployed") {
    return (
      <div className="flex flex-col gap-4">
        <Crumbs roundId={id.toString()} />
        <NotDeployedState detail={state.detail} />
      </div>
    );
  }
  if (state.status === "error" || !detail || !round) {
    const message = state.status === "error" ? state.message : "";
    const notFound = message.startsWith("Round #") && message.includes("does not exist");
    return (
      <div className="flex flex-col gap-4">
        <Crumbs roundId={id.toString()} />
        {notFound ? (
          <EmptyState illustration="ledger" title={`Round #${id.toString()} does not exist`} description="The engine has no round with this id. It may not have been created yet, or the link points at another deployment." action={<ButtonLink href={ROUTES.rounds} size="sm" variant="secondary">All rounds</ButtonLink>} />
        ) : (
          <ErrorState message={message} onRetry={retry} />
        )}
      </div>
    );
  }

  const action = nextAction(round, now);
  const bidding = action.kind === "bid" || action.kind === "wait_open";
  const items: TabItem<TabId>[] = [
    { id: "overview", label: "Overview" },
    { id: "book", label: opened > 0 ? "Book" : "Sealed book", count: detail.bids.length },
    ...(hasResults ? [{ id: "results" as const, label: "Results" }] : []),
    ...(mine.length > 0 ? [{ id: "mine" as const, label: "My orders", count: mine.length }] : []),
    { id: "details", label: "Details" },
  ];

  return (
    <div data-round-detail={round.roundId.toString()} data-round-status={round.status}>
      <ActionLayout
        header={<RoundHeader detail={detail} nowMs={now} refreshing={refreshing} onRefresh={refresh} />}
        action={
          bidding ? (
            <>
              <OrderForm detail={detail} nowMs={now} onPlaced={refresh} />
              <RoundExtraActions detail={detail} nowMs={now} onChanged={refresh} />
            </>
          ) : (
            <RoundAction detail={detail} nowMs={now} onChanged={refresh}>
              <FinalizePanel detail={detail} onChanged={refresh} />
            </RoundAction>
          )
        }
      >
        <div className="scroll-mt-[72px]" data-round-tabs>
          <Tabs items={items} value={tabs.value} onChange={tabs.select} idBase={tabs.idBase} label="Round sections" />
        </div>
        <TabPanel idBase={tabs.idBase} id="overview" value={tabs.value} className="flex flex-col gap-4">
          <p className="text-[13px] text-ink-300">
            {KIND_BLURB[round.kind]} <LearnMore topic="sealedRounds" />
          </p>
          <StatusTimeline detail={detail} nowMs={now} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="book" value={tabs.value}>
          <SealedBook detail={detail} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="results" value={tabs.value} className="flex flex-col gap-4">
          <Curves detail={detail} />
          <FillsTable detail={detail} onChanged={refresh} />
          <VerifyPanel detail={detail} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="mine" value={tabs.value}>
          <MyOrders detail={detail} onChanged={refresh} />
        </TabPanel>
        <TabPanel idBase={tabs.idBase} id="details" value={tabs.value}>
          <RoundDetails detail={detail} />
        </TabPanel>
      </ActionLayout>
    </div>
  );
}
