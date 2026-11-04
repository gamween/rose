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

/**
 * Runs `fetcher` on mount, again every time `refreshKey` changes, and on `retry`. A previous
 * value is kept on screen while a refresh is in flight; errors replace it only when there is
 * nothing to show yet or the caller retries explicitly. `fetcher` must be referentially stable
 * (wrap it in `useCallback`), as a new function restarts the query.
 */
export function useLiveQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  refreshKey: number,
): { state: QueryState<T>; retry: () => void; refreshing: boolean } {
  const [state, setState] = useState<QueryState<T>>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (replace: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (replace) setState({ status: "loading" });
      setRefreshing(true);
      try {
        const value = await fetcher(controller.signal);
        if (controller.signal.aborted) return;
        setState({ status: "ok", value, fetchedAt: Date.now() });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof NotDeployedError) {
          setState({ status: "not_deployed", detail: error.message });
        } else if (error instanceof EngineViewError && NOT_DEPLOYED_KINDS.has(error.kind)) {
          setState({ status: "not_deployed", detail: error.message });
        } else {
          const message = error instanceof Error ? error.message : "Unknown error";
          setState((previous) => (previous.status === "ok" && !replace ? previous : { status: "error", message, fetchedAt: Date.now() }));
        }
      } finally {
        if (!controller.signal.aborted) setRefreshing(false);
      }
    },
    [fetcher],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void run(false), 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [run, refreshKey]);

  const retry = useCallback(() => void run(true), [run]);

  return { state, retry, refreshing };
}
