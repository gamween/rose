"use client";

import type { ClassInfo, Round } from "@rose/sdk";
import Link from "next/link";
import type { ReactNode } from "react";
import { Countdown } from "@/components/ui/Countdown";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { cn } from "@/lib/cn";
import { ROUTES } from "@/lib/routes";
import { cancelledOutcome, classShortLabel, clearingOf, formatDateTime, formatQty, formatUsdc, lockedPercent, NEXT_ACTION_LABEL, nextAction, nsToMs, roundProgress, scheduleEndSecs, venueLabel, venueTokenAccount, type NextAction } from "./model";
import { DateTimeText, KindBadge, StatusBadge } from "./shared";
import type { BookSummary } from "./useRoundsList";

function collateral(round: Round, decimals: number): { label: string; value: string } {
  if (round.kind === "Tender") return { label: "Budget", value: `${formatUsdc(round.budget ?? 0n)} USDC` };
  if (round.kind === "Advance") return { label: "Claim", value: `${formatQty(round.advanceClaim ?? 0n, decimals)} tokens` };
  return { label: "Max price", value: `${formatUsdc(round.maxPrice)} USDC` };
}

function actionLine(action: NextAction, nowMs: number): { text: string; countdown: number | null } {
  switch (action.kind) {
    case "wait_open":
      return { text: "Opens in", countdown: action.at };
    case "bid":
      return { text: "Closes in", countdown: action.closesAt };
    case "close":
      return { text: "Closed · anyone can close the round", countdown: null };
    case "waiting_key":
      return { text: "Key requested from the MPC", countdown: null };
    case "cancel_no_key":
      return { text: "No key · anyone can cancel", countdown: null };
    case "finalize":
      return { text: `${String(action.remaining)} to open · window ends in`, countdown: action.until };
    case "wait_reveal":
      return { text: "All opened · window ends in", countdown: action.until };
    case "clear":
      return { text: "Window closed · anyone can clear", countdown: null };
    case "settle":
      return { text: `${String(action.pending)} ${action.pending === 1 ? "order" : "orders"} to settle`, countdown: null };
    case "done":
      return { text: nowMs > 0 ? "Everything settled" : "", countdown: null };
  }
}

function bookLine(round: Round, book: BookSummary | null, decimals: number): string | null {
  if (!book || round.bidCount === 0) return null;
  const parts: string[] = [];
  if (book.escrow > 0n) parts.push(`${formatUsdc(book.escrow)} USDC escrowed`);
  if (book.lockedUnits > 0n) parts.push(`${formatQty(book.lockedUnits, decimals)} units locked`);
  return parts.join(" · ") || null;
}

/** A small label over its value, the cell of a round row. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] text-ink-400 font-medium">{label}</dt>
      <dd className="tabular text-[13px] text-ink-100 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/**
 * One round of the list as a market row (launchpad lists: Fjord, CoinList): the round, its class and
 * status, three numbers and the clock, the whole row linking to the round. Cells stack into a
 * card on a phone.
 */
export function RoundCard({ round, cls, symbol, book, nowMs }: { round: Round; cls: ClassInfo | null; symbol: string | null; book: BookSummary | null; nowMs: number }) {
  const decimals = cls?.decimals ?? 18;
  const action = nextAction(round, nowMs);
  const line = actionLine(action, nowMs);
  const money = collateral(round, decimals);
  const sealed = bookLine(round, book, decimals);
  const progress = roundProgress(round, nowMs);
  const href = `${ROUTES.rounds}/${round.roundId.toString()}`;
  const terminal = round.status === "Settled" || round.status === "Cancelled";
  const cleared = clearingOf(round);
  const live = action.kind === "bid";

  return (
    <article
      className={cn(
        "group relative grid grid-cols-3 items-center gap-x-4 gap-y-3 px-4 py-3.5 transition-colors hover:bg-ink-800/60 md:grid-cols-[minmax(0,1.7fr)_repeat(3,minmax(0,1fr))_minmax(0,1.3fr)_12px]",
        live && "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-ember-500",
      )}
      data-round-card={round.roundId.toString()}
    >
      <div className="col-span-3 flex min-w-0 items-start justify-between gap-3 md:col-span-1">
        <div className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5">
            <Link href={href} className="text-[14px] text-ink-50 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline font-semibold tracking-tight">
              Round #{round.roundId.toString()}
            </Link>
            <KindBadge kind={round.kind} />
          </span>
          <p className="mt-0.5 truncate text-[12px] text-ink-400" title={cls ? `Token ${cls.token} on ${cls.chain} · class ${cls.classId} · cash ${venueTokenAccount(round.venue)}` : round.classId}>
            {cls ? classShortLabel(cls, symbol) : `Class ${round.classId.slice(0, 10)}…`}
            {cls ? (
              <>
                {" "}
                · until <DateTimeText ms={scheduleEndSecs(cls) * 1000} withTime={false} />
              </>
            ) : null}
            <span className="max-sm:hidden"> · {venueLabel(round.venue)}</span>
          </p>
        </div>
        <StatusBadge status={round.status} className="shrink-0 md:hidden" />
      </div>
      <dl className="contents">
        <Cell label={money.label}>{money.value}</Cell>
        <Cell label="Orders">{String(round.bidCount)}</Cell>
        {sealed ? (
          <div className="sr-only" data-round-book>
            <dt>Public collateral</dt>
            <dd>{sealed}</dd>
          </div>
        ) : null}
        <Cell label={round.status === "Cancelled" ? "Outcome" : cleared ? "Cleared at" : "Locked at close"}>{round.status === "Cancelled" ? cancelledOutcome(round) : cleared ? `${formatUsdc(cleared.price)} USDC` : lockedPercent(round.fTs)}</Cell>
      </dl>
      <div className="col-span-3 flex min-w-0 flex-col gap-1.5 md:col-span-1">
        <span className="flex items-center justify-between gap-2 text-[12px]">
          <StatusBadge status={round.status} className="max-md:hidden" />
          <span className="flex min-w-0 items-center gap-1.5 text-ink-300 md:justify-end">
            <span className={cn("truncate", action.kind === "close" || action.kind === "clear" || action.kind === "finalize" || action.kind === "settle" ? "text-ember-300" : undefined)}>{line.text}</span>
            {line.countdown !== null ? <Countdown target={line.countdown} endedLabel="now" className="text-ink-50" /> : null}
          </span>
        </span>
        <ProgressBar value={progress} tone={terminal ? (round.status === "Settled" ? "success" : "danger") : "ember"} />
      </div>
      <svg viewBox="0 0 6 10" width="6" height="10" shapeRendering="crispEdges" className="hidden text-ink-500 transition-colors group-hover:text-ink-200 md:block" aria-hidden>
        <path d="M0 0h2v2H0zM2 2h2v2H2zM4 4h2v2H4zM2 6h2v2H2zM0 8h2v2H0z" fill="currentColor" />
      </svg>
      <span className="sr-only">
        {NEXT_ACTION_LABEL[action.kind]}. Closes {formatDateTime(nsToMs(round.closesAt))}.
      </span>
    </article>
  );
}
