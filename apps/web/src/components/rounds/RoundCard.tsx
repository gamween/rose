"use client";

import type { ClassInfo, Round } from "@rose/sdk";
import Link from "next/link";
import { Countdown } from "@/components/ui/Countdown";
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

  return (
    <article className="group relative flex flex-col gap-3 rounded-lg border border-ink-750 bg-ink-850 p-4 transition-colors hover:border-ink-600" data-round-card={round.roundId.toString()}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={href} className="font-display text-[15px] text-ink-50 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline">
            Round #{round.roundId.toString()}
          </Link>
          <p className="mt-0.5 text-[12px] text-ink-400" title={cls ? `Token ${cls.token} on ${cls.chain} · class ${cls.classId}` : round.classId}>
            {cls ? classShortLabel(cls, symbol) : `Class ${round.classId.slice(0, 10)}…`}
            {cls ? (
              <span className="text-ink-400">
                {" "}
                · unlocks until <DateTimeText ms={scheduleEndSecs(cls) * 1000} withTime={false} />
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <KindBadge kind={round.kind} />
          <StatusBadge status={round.status} />
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">{money.label}</dt>
          <dd className="tabular text-[13px] text-ink-100 [overflow-wrap:anywhere]">{money.value}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">Sealed orders</dt>
          <dd className="tabular text-[13px] text-ink-100">{String(round.bidCount)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">{round.status === "Cancelled" ? "Outcome" : cleared ? "Cleared at" : "Locked at close"}</dt>
          <dd className="tabular text-[13px] text-ink-100 [overflow-wrap:anywhere]">
            {round.status === "Cancelled" ? cancelledOutcome(round) : cleared ? `${formatUsdc(cleared.price)} USDC` : lockedPercent(round.fTs)}
          </dd>
        </div>
        {sealed ? (
          <div className="col-span-2 min-w-0 sm:col-span-3" data-round-book>
            <dt className="sr-only">Public collateral</dt>
            <dd className="tabular text-[12px] text-ink-400 [overflow-wrap:anywhere]">{sealed}</dd>
          </div>
        ) : null}
      </dl>

      <div className="h-1 w-full overflow-hidden rounded-sm bg-ink-800" aria-hidden>
        <div className={cn("h-full transition-[width] duration-700", terminal ? (round.status === "Settled" ? "bg-success-500" : "bg-danger-500") : "bg-ember-500")} style={{ width: `${String(Math.round(progress * 100))}%` }} />
      </div>

      <footer className="flex items-center justify-between gap-3 text-[12px]">
        <span className="truncate text-ink-400" title={venueTokenAccount(round.venue)}>
          {venueLabel(round.venue)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-ink-200">
          <span className={cn(action.kind === "close" || action.kind === "clear" || action.kind === "finalize" || action.kind === "settle" ? "text-ember-300" : undefined)}>{line.text}</span>
          {line.countdown !== null ? <Countdown target={line.countdown} endedLabel="now" className="text-ink-50" /> : null}
        </span>
      </footer>
      <span className="sr-only">
        {NEXT_ACTION_LABEL[action.kind]}. Closes {formatDateTime(nsToMs(round.closesAt))}.
      </span>
    </article>
  );
}
