"use client";

/**
 * `/app/rounds` (spec 8.3), laid out like a launchpad list: the live round first, compact filters
 * (type, status, class), then one row per round with its status, three numbers and its clock,
 * cursor pagination, and the "Create Exit round" action.
 */

import type { ConfigView, Limits, RoundKind, RoundStatus } from "@rose/sdk";
import { useEffect, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { selectClasses } from "@/components/ui/Input";
import { NextStep } from "@/components/ui/NextStep";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { Term } from "@/components/ui/Term";
import { cn } from "@/lib/cn";
import { toActionError } from "@/lib/errors";
import { ROUTES } from "@/lib/routes";
import { CreateExitModal } from "./CreateExitModal";
import { symbolOf } from "./engine";
import { classShortLabel, formatDate, KIND_LABEL, nextAction, scheduleEndSecs, STATUS_LABEL } from "./model";
import { RoundCard } from "./RoundCard";
import { ErrorState, LoadingRows, NotDeployedState } from "./shared";
import { EMPTY_FILTER, useRoundsList, type RoundsFilterState } from "./useRoundsList";

const KINDS: RoundKind[] = ["Tender", "Exit", "Advance"];
const STATUSES: RoundStatus[] = ["Open", "KeyRequested", "Revealing", "Clearing", "Settled", "Cancelled", "Scheduled"];

const KIND_OPTIONS: SegmentedOption<RoundKind | "all">[] = [{ value: "all", label: "All" }, ...KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }))];

/** `demo`: the configured engine has a guided demo of its seeded rounds. */
export function RoundsPage({ configured, demo }: { configured: boolean; demo: boolean }) {
  const [filter, setFilter] = useState<RoundsFilterState>(EMPTY_FILTER);
  const [createOpen, setCreateOpen] = useState(false);
  const [settings, setSettings] = useState<{ config: ConfigView; limits: Limits } | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsAttempt, setSettingsAttempt] = useState(0);
  const list = useRoundsList(filter);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const data = list.state.status === "ok" ? list.state.value : null;
  useEffect(() => {
    if (!data || settings || !createOpen) return;
    let cancelled = false;
    void Promise.all([data.engine.views.getConfig(), data.engine.views.getLimits()])
      .then(([config, limits]) => {
        if (cancelled) return;
        setSettings({ config, limits });
        setSettingsError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setSettingsError(toActionError(error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen, data, settings, settingsAttempt]);

  const classesById = useMemo(() => new Map((data?.classes ?? []).map((cls) => [cls.classId, cls])), [data]);
  const rounds = useMemo(() => [...(data?.rounds ?? []), ...list.extra], [data, list.extra]);
  const nextCursor = list.extra.length > 0 ? list.extraNext : (data?.next ?? null);
  const filtered = filter.kind !== "" || filter.classId !== "" || filter.status !== "";
  const openRound = rounds.find((round) => nextAction(round, now).kind === "bid") ?? null;

  return (
    <div className="flex flex-col gap-5" data-rounds-page>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-ink-50">Rounds</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-400">
            Sealed, <Term term="uniformPrice">uniform-price</Term> auctions over locked token <Term term="class">classes</Term>. <LearnMore topic="sealedRounds" />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {demo ? (
            <ButtonLink href={ROUTES.demo} size="sm" variant="ghost" data-watch-demo>
              Watch a full round
            </ButtonLink>
          ) : null}
          <Button size="sm" variant={openRound ? "secondary" : "primary"} onClick={() => setCreateOpen(true)} disabled={!data} data-create-exit>
            Create Exit round
          </Button>
        </div>
      </header>

      {!configured ? (
        <NotDeployedState />
      ) : (
        <>
          {openRound ? (
            <NextStep
              title={`Round #${openRound.roundId.toString()} is taking sealed orders`}
              description={
                <>
                  Nobody sees your price before the close, and every winning order pays the same <Term term="clearingPrice">clearing price</Term>.
                </>
              }
              action={
                <ButtonLink href={`${ROUTES.rounds}/${openRound.roundId.toString()}`} size="sm">
                  Open round #{openRound.roundId.toString()}
                </ButtonLink>
              }
            />
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between" role="group" aria-label="Filters">
            <Segmented
              label="Round type"
              options={KIND_OPTIONS}
              value={filter.kind === "" ? "all" : filter.kind}
              onChange={(kind) => setFilter((f) => ({ ...f, kind: kind === "all" || f.kind === kind ? "" : kind }))}
              data-filter-group="type"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Status"
                value={filter.status}
                onChange={(event) => setFilter((f) => ({ ...f, status: event.target.value as RoundStatus | "" }))}
                className={selectClasses(undefined, "sm", false)}
                data-filter-group="status"
              >
                <option value="">All statuses</option>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
              {data && data.classes.length > 0 ? (
                <select
                  aria-label="Class"
                  value={filter.classId}
                  onChange={(event) => setFilter((f) => ({ ...f, classId: event.target.value }))}
                  className={selectClasses("max-w-[320px]", "sm", false)}
                  data-filter-group="class"
                >
                  <option value="">All classes</option>
                  {data.classes.map((cls) => (
                    <option key={cls.classId} value={cls.classId}>
                      {classShortLabel(cls, symbolOf(data.symbols, cls))} · until {formatDate(scheduleEndSecs(cls) * 1000)}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>

          {list.state.status === "loading" ? <LoadingRows /> : null}
          {list.state.status === "not_deployed" ? <NotDeployedState detail={list.state.detail} /> : null}
          {list.state.status === "error" ? <ErrorState message={list.state.message} onRetry={list.retry} /> : null}
          {data ? (
            rounds.length === 0 ? (
              <EmptyState
                illustration={filtered ? "ledger" : "tender"}
                title={filtered ? "No round matches these filters" : "No round yet"}
                description={
                  filtered
                    ? "Clear a filter, or create an Exit round on one of the classes."
                    : "Rounds appear here as issuers launch Tenders, holders open Advances and anyone creates an Exit. Create the first one on a class with locked tokens."
                }
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {filtered ? (
                      <Button size="sm" variant="secondary" onClick={() => setFilter(EMPTY_FILTER)}>
                        Clear filters
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => setCreateOpen(true)}>
                      Create Exit round
                    </Button>
                  </div>
                }
              />
            ) : (
              <>
                <div className="ui-surface divide-y divide-ink-750 overflow-hidden rounded-lg" data-rounds-list>
                  {rounds.map((round) => {
                    const cls = classesById.get(round.classId) ?? null;
                    const book = data.books.get(round.roundId.toString()) ?? list.extraBooks.get(round.roundId.toString()) ?? null;
                    return <RoundCard key={round.roundId.toString()} round={round} cls={cls} symbol={cls ? symbolOf(data.symbols, cls) : null} book={book} nowMs={now} />;
                  })}
                </div>
                <div className="flex items-center justify-between text-[12px] text-ink-400">
                  <span className="tabular">
                    {String(rounds.length)} {rounds.length === 1 ? "round" : "rounds"}
                    {nextCursor !== null ? " shown" : ""}
                  </span>
                  <span className={cn("tabular transition-opacity", list.refreshing ? "opacity-100" : "opacity-0")} aria-live="polite">
                    refreshing…
                  </span>
                </div>
                {nextCursor !== null ? (
                  <div className="flex flex-col items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void list.loadMore()} loading={list.loadingMore} loadingLabel="Loading…" data-load-more>
                      Load older rounds (before #{nextCursor.toString()})
                    </Button>
                    {list.loadMoreError ? <p className="text-[12px] text-danger-400">{list.loadMoreError}</p> : null}
                  </div>
                ) : null}
              </>
            )
          ) : null}
          {data ? <CreateExitModal open={createOpen} onClose={() => setCreateOpen(false)} engine={data.engine} classes={data.classes} symbols={data.symbols} settings={settings} settingsError={settingsError} onRetrySettings={() => {
                setSettingsError(null);
                setSettingsAttempt((attempt) => attempt + 1);
              }} /> : null}
        </>
      )}
    </div>
  );
}
