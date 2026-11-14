"use client";

/**
 * The filterable rounds list, newest first (the open rounds are the newest), paged backwards in
 * id windows below `stats().rounds_total` (see `fetchNewestRounds`). Classes and token symbols are
 * read once for the filter and the card labels.
 */

import type { ClassInfo, Round, RoundFilter, RoundKind, RoundStatus } from "@rose/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveQuery, type QueryState } from "@/components/status/useLiveQuery";
import { classSymbols, fetchAllClasses, fetchNewestRounds, rethrowNotDeployed, roundsEngine, type RoundsEngine } from "./engine";

export interface RoundsFilterState {
  kind: RoundKind | "";
  classId: string;
  status: RoundStatus | "";
}

export const EMPTY_FILTER: RoundsFilterState = { kind: "", classId: "", status: "" };

export function toRoundFilter(filter: RoundsFilterState): RoundFilter {
  const out: RoundFilter = {};
  if (filter.kind) out.kind = filter.kind;
  if (filter.classId) out.class_id = filter.classId;
  if (filter.status) out.status = filter.status;
  return out;
}

/** Public collateral of a sealed book: cash escrowed by buyers and units locked by sellers. */
export interface BookSummary {
  escrow: bigint;
  lockedUnits: bigint;
  buys: number;
  sells: number;
}

export interface RoundsListData {
  engine: RoundsEngine;
  classes: ClassInfo[];
  symbols: Map<string, string>;
  rounds: Round[];
  books: Map<string, BookSummary>;
  next: bigint | null;
  blockTimeMs: number;
}

async function summarizeBooks(engine: RoundsEngine, rounds: readonly Round[], signal: AbortSignal): Promise<Map<string, BookSummary>> {
  const out = new Map<string, BookSummary>();
  const books = await Promise.all(rounds.map((round) => (round.bidCount > 0 ? engine.views.getBids(round.roundId, { signal }) : Promise.resolve([]))));
  rounds.forEach((round, index) => {
    const bids = books[index] ?? [];
    const summary: BookSummary = { escrow: 0n, lockedUnits: 0n, buys: 0, sells: 0 };
    for (const bid of bids) {
      if (bid.side === "Buy") {
        summary.escrow += bid.escrow;
        summary.buys += 1;
      } else {
        summary.lockedUnits += bid.lockedUnits;
        summary.sells += 1;
      }
    }
    out.set(round.roundId.toString(), summary);
  });
  return out;
}

const POLL_MS = 15_000;

/** The first page lists the newest rounds (the open ones), starting below the next round id. */
async function fetchFirstPage(filter: RoundFilter, signal: AbortSignal): Promise<RoundsListData> {
  const engine = roundsEngine();
  if (!engine) throw new Error("engine not configured");
  try {
    const [classes, block, stats] = await Promise.all([fetchAllClasses(engine, signal), engine.views.raw.rpc.block("final", signal), engine.views.stats({ signal })]);
    const symbols = await classSymbols(classes);
    const { rounds, next } = await fetchNewestRounds(engine, filter, BigInt(stats.roundsTotal), signal);
    const books = await summarizeBooks(engine, rounds, signal);
    return { engine, classes, symbols, rounds, books, next, blockTimeMs: Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) };
  } catch (error) {
    rethrowNotDeployed(error);
  }
}

export function useRoundsList(filter: RoundsFilterState): {
  state: QueryState<RoundsListData>;
  retry: () => void;
  refreshing: boolean;
  /** The rounds on screen answer the previous filter; the current one is still loading. */
  stale: boolean;
  loadMore: () => Promise<void>;
  loadingMore: boolean;
  extra: Round[];
  extraBooks: Map<string, BookSummary>;
  extraNext: bigint | null;
  loadMoreError: string | null;
} {
  const roundFilter = useMemo(() => toRoundFilter(filter), [filter]);
  const [refreshKey, setRefreshKey] = useState(0);
  const fetcher = useCallback((signal: AbortSignal) => fetchFirstPage(roundFilter, signal), [roundFilter]);
  const { state, retry, refreshing, stale } = useLiveQuery(fetcher, refreshKey, { replaceOnNewQuery: true });

  const filterKey = JSON.stringify(roundFilter);
  const [extraState, setExtraState] = useState<{ key: string; rounds: Round[]; books: Map<string, BookSummary>; next: bigint | null }>({ key: filterKey, rounds: [], books: new Map(), next: null });
  const extra = extraState.key === filterKey ? extraState.rounds : [];
  const extraBooks = extraState.key === filterKey ? extraState.books : new Map<string, BookSummary>();
  const extraNext = extraState.key === filterKey ? extraState.next : null;
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "not_deployed") return;
    const timer = window.setInterval(() => setRefreshKey((key) => key + 1), POLL_MS);
    return () => window.clearInterval(timer);
  }, [state.status]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ok") return;
    const cursor = extra.length > 0 ? extraNext : state.value.next;
    if (cursor === null) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const signal = new AbortController().signal;
      const page = await fetchNewestRounds(state.value.engine, roundFilter, cursor, signal);
      const books = await summarizeBooks(state.value.engine, page.rounds, signal);
      setExtraState((current) => {
        const same = current.key === filterKey;
        return { key: filterKey, rounds: [...(same ? current.rounds : []), ...page.rounds], books: new Map([...(same ? current.books : new Map<string, BookSummary>()), ...books]), next: page.next };
      });
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : "Could not load more rounds.");
    } finally {
      setLoadingMore(false);
    }
  }, [extra.length, extraNext, filterKey, roundFilter, state]);

  return { state, retry, refreshing, stale, loadMore, loadingMore, extra, extraBooks, extraNext, loadMoreError };
}
