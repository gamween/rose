"use client";

/**
 * The filterable, cursor-paginated rounds list (`get_rounds` returns `{ rounds, next }`; the
 * engine scans at most 200 ids per call, so an empty page with a cursor just means "keep
 * scanning"). Classes and token symbols are read once for the filter and the card labels.
 */

import type { ClassInfo, Round, RoundFilter, RoundKind, RoundStatus } from "@rose/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveQuery, type QueryState } from "@/components/status/useLiveQuery";
import { classSymbols, fetchAllClasses, fetchRoundsPage, rethrowNotDeployed, roundsEngine, ROUNDS_PAGE_SIZE, type RoundsEngine } from "./engine";

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
/** Pages fetched in one go while the scan window returns nothing (sparse filters). */
const MAX_EMPTY_SCANS = 5;

async function fetchFirstPage(filter: RoundFilter, signal: AbortSignal): Promise<RoundsListData> {
  const engine = roundsEngine();
  if (!engine) throw new Error("engine not configured");
  try {
    const [classes, block] = await Promise.all([fetchAllClasses(engine, signal), engine.views.raw.rpc.block("final", signal)]);
    const symbols = await classSymbols(classes);
    const { rounds, next } = await fetchPages(engine, filter, null, signal);
    const books = await summarizeBooks(engine, rounds, signal);
    return { engine, classes, symbols, rounds, books, next, blockTimeMs: Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) };
  } catch (error) {
    rethrowNotDeployed(error);
  }
}

/** Keeps scanning while the engine returns an empty window with a cursor, up to a bounded number of calls. */
async function fetchPages(engine: RoundsEngine, filter: RoundFilter, from: bigint | null, signal: AbortSignal): Promise<{ rounds: Round[]; next: bigint | null }> {
  const rounds: Round[] = [];
  let cursor = from;
  for (let scans = 0; scans < MAX_EMPTY_SCANS; scans += 1) {
    const page = await fetchRoundsPage(engine, filter, cursor, ROUNDS_PAGE_SIZE, signal);
    rounds.push(...page.rounds);
    cursor = page.next;
    if (cursor === null || rounds.length >= ROUNDS_PAGE_SIZE) break;
  }
  return { rounds, next: cursor };
}

export function useRoundsList(filter: RoundsFilterState): {
  state: QueryState<RoundsListData>;
  retry: () => void;
  refreshing: boolean;
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
  const { state, retry, refreshing } = useLiveQuery(fetcher, refreshKey);

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
      const page = await fetchPages(state.value.engine, roundFilter, cursor, signal);
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

  return { state, retry, refreshing, loadMore, loadingMore, extra, extraBooks, extraNext, loadMoreError };
}
