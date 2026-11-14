"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EngineViewError } from "@/lib/engine";

export type QueryState<T> =
  | { status: "loading" }
  | { status: "ok"; value: T; fetchedAt: number }
  | { status: "not_deployed"; detail: string }
  | { status: "error"; message: string; fetchedAt: number };

/** Thrown by a fetcher to report that what it reads is not deployed yet (shown as a calm state, not an error). */
export class NotDeployedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "NotDeployedError";
  }
}

const NOT_DEPLOYED_KINDS = new Set(["account_missing", "no_contract", "method_missing"]);

/** `read` reads the current query (on mount, on a new fetcher and on each refresh), `retry` starts over. */
export type RunMode = "read" | "retry";

/**
 * Whether a failed read leaves the previous value on screen. A retry never does. A read of a query
 * that has not answered yet (a new filter, even when a poll restarted its first read) does only
 * without `replaceOnNewQuery`; a refresh of a query that has answered always does.
 */
export function keepsValueOnFailure(mode: RunMode, answered: boolean, replaceOnNewQuery: boolean): boolean {
  return mode === "read" && (answered || !replaceOnNewQuery);
}

/**
 * Runs `fetcher` on mount, again every time `refreshKey` changes, and on `retry`. A previous
 * value is kept on screen while a refresh is in flight; errors replace it only when there is
 * nothing to show yet or the caller retries explicitly. `fetcher` must be referentially stable
 * (wrap it in `useCallback`): a new function is a new query. Until it answers, the previous
 * query's value stays on screen flagged `stale`. With `replaceOnNewQuery` (a list under a new
 * filter), a failure of the new query replaces that value, so an answer to another filter never
 * passes for the current one; without it (the same round read with a wallet now connected), the
 * previous value stays as it would through a refresh.
 */
export function useLiveQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  refreshKey: number,
  { replaceOnNewQuery = false }: { replaceOnNewQuery?: boolean } = {},
): { state: QueryState<T>; retry: () => void; refreshing: boolean; stale: boolean } {
  const [state, setState] = useState<QueryState<T>>({ status: "loading" });
  const [answered, setAnswered] = useState<((signal: AbortSignal) => Promise<T>) | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  /** The fetcher whose answer is on screen, read by `run` without making it a dependency. */
  const answeredRef = useRef<((signal: AbortSignal) => Promise<T>) | null>(null);

  const run = useCallback(
    async (mode: RunMode) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (mode === "retry") setState({ status: "loading" });
      setRefreshing(true);
      try {
        const value = await fetcher(controller.signal);
        if (controller.signal.aborted) return;
        setState({ status: "ok", value, fetchedAt: Date.now() });
        answeredRef.current = fetcher;
        setAnswered(() => fetcher);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof NotDeployedError) {
          setState({ status: "not_deployed", detail: error.message });
        } else if (error instanceof EngineViewError && NOT_DEPLOYED_KINDS.has(error.kind)) {
          setState({ status: "not_deployed", detail: error.message });
        } else {
          const message = error instanceof Error ? error.message : "Unknown error";
          const keep = keepsValueOnFailure(mode, answeredRef.current === fetcher, replaceOnNewQuery);
          setState((previous) => (previous.status === "ok" && keep ? previous : { status: "error", message, fetchedAt: Date.now() }));
        }
      } finally {
        if (!controller.signal.aborted) setRefreshing(false);
      }
    },
    [fetcher, replaceOnNewQuery],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void run("read"), 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [run, refreshKey]);

  const retry = useCallback(() => void run("retry"), [run]);

  return { state, retry, refreshing, stale: state.status === "ok" && answered !== fetcher };
}
