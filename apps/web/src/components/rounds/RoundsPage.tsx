"use client";

/**
 * `/app/rounds` (spec 8.3): filterable list (type, class, status) with countdowns, round cards,
 * cursor pagination and the "Create Exit round" action.
 */

import type { ConfigView, RoundKind, RoundStatus } from "@rose/sdk";
import { useEffect, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";
import { CreateExitModal } from "./CreateExitModal";
import { symbolOf } from "./engine";
import { classShortLabel, formatDate, KIND_LABEL, scheduleEndSecs, STATUS_LABEL } from "./model";
import { RoundCard } from "./RoundCard";
import { ErrorState, LoadingCards, NotDeployedState } from "./shared";
import { EMPTY_FILTER, useRoundsList, type RoundsFilterState } from "./useRoundsList";

const KINDS: RoundKind[] = ["Tender", "Exit", "Advance"];
const STATUSES: RoundStatus[] = ["Open", "KeyRequested", "Revealing", "Clearing", "Settled", "Cancelled", "Scheduled"];

function Chip({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: React.ReactNode; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors",
        active ? "border-ember-500 bg-ember-700/25 text-ember-200" : "border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-500 hover:text-ink-100",
      )}
    >
      {children}
      {count !== undefined ? <span className="tabular text-[11px] text-ink-400">{count}</span> : null}
    </button>
  );
}

export function RoundsPage({ configured }: { configured: boolean }) {
  const [filter, setFilter] = useState<RoundsFilterState>(EMPTY_FILTER);
  const [createOpen, setCreateOpen] = useState(false);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const list = useRoundsList(filter);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const data = list.state.status === "ok" ? list.state.value : null;
  useEffect(() => {
    if (!data || config) return;
    let cancelled = false;
    void data.engine.views
      .getConfig()
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [config, data]);

  const classesById = useMemo(() => new Map((data?.classes ?? []).map((cls) => [cls.classId, cls])), [data]);
  const rounds = useMemo(() => [...(data?.rounds ?? []), ...list.extra], [data, list.extra]);
  const nextCursor = list.extra.length > 0 ? list.extraNext : (data?.next ?? null);
  const filtered = filter.kind !== "" || filter.classId !== "" || filter.status !== "";

  return (
    <div className="flex flex-col gap-5" data-rounds-page>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] text-ink-50">Rounds</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-400">
            Sealed, uniform-price auctions over locked token classes. Every transition is a public method: whoever cares about the outcome advances the round. <LearnMore topic="sealedRounds" />
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!data} data-create-exit>
          Create Exit round
        </Button>
      </header>

      {!configured ? (
        <NotDeployedState />
      ) : (
        <>
          <div className="flex flex-col gap-2 rounded-lg border border-ink-750 bg-ink-850 p-3" role="group" aria-label="Filters">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 font-display text-[10px] uppercase tracking-wide text-ink-400">Type</span>
              <Chip active={filter.kind === ""} onClick={() => setFilter((f) => ({ ...f, kind: "" }))}>
                All
              </Chip>
              {KINDS.map((kind) => (
                <Chip key={kind} active={filter.kind === kind} onClick={() => setFilter((f) => ({ ...f, kind: f.kind === kind ? "" : kind }))}>
                  {KIND_LABEL[kind]}
                </Chip>
              ))}
              <span className="mx-1 hidden h-4 w-px bg-ink-700 sm:block" aria-hidden />
              <span className="mr-1 font-display text-[10px] uppercase tracking-wide text-ink-400">Status</span>
              <Chip active={filter.status === ""} onClick={() => setFilter((f) => ({ ...f, status: "" }))}>
                Any
              </Chip>
              {STATUSES.map((status) => (
                <Chip key={status} active={filter.status === status} onClick={() => setFilter((f) => ({ ...f, status: f.status === status ? "" : status }))}>
                  {STATUS_LABEL[status]}
                </Chip>
              ))}
            </div>
            {data && data.classes.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 font-display text-[10px] uppercase tracking-wide text-ink-400">Class</span>
                <Chip active={filter.classId === ""} onClick={() => setFilter((f) => ({ ...f, classId: "" }))}>
                  All
                </Chip>
                {data.classes.map((cls) => (
                  <Chip key={cls.classId} active={filter.classId === cls.classId} onClick={() => setFilter((f) => ({ ...f, classId: f.classId === cls.classId ? "" : cls.classId }))}>
                    {classShortLabel(cls, symbolOf(data.symbols, cls))}
                    <span className="text-ink-400"> · until {formatDate(scheduleEndSecs(cls) * 1000)}</span>
                  </Chip>
                ))}
              </div>
            ) : null}
          </div>

          {list.state.status === "loading" ? <LoadingCards /> : null}
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
                <div className="flex items-center justify-between text-[12px] text-ink-400">
                  <span className="tabular">
                    {String(rounds.length)} {rounds.length === 1 ? "round" : "rounds"}
                    {nextCursor !== null ? " shown" : ""} · engine {data.engine.account}
                  </span>
                  <span className={cn("tabular transition-opacity", list.refreshing ? "opacity-100" : "opacity-0")} aria-live="polite">
                    refreshing…
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {rounds.map((round) => {
                    const cls = classesById.get(round.classId) ?? null;
                    const book = data.books.get(round.roundId.toString()) ?? list.extraBooks.get(round.roundId.toString()) ?? null;
                    return <RoundCard key={round.roundId.toString()} round={round} cls={cls} symbol={cls ? symbolOf(data.symbols, cls) : null} book={book} nowMs={now} />;
                  })}
                </div>
                {nextCursor !== null ? (
                  <div className="flex flex-col items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void list.loadMore()} loading={list.loadingMore} loadingLabel="Loading…" data-load-more>
                      Load more (from #{nextCursor.toString()})
                    </Button>
                    {list.loadMoreError ? <p className="text-[12px] text-danger-400">{list.loadMoreError}</p> : null}
                  </div>
                ) : null}
              </>
            )
          ) : null}
          {data ? <CreateExitModal open={createOpen} onClose={() => setCreateOpen(false)} engine={data.engine} classes={data.classes} symbols={data.symbols} config={config} /> : null}
        </>
      )}
    </div>
  );
}
