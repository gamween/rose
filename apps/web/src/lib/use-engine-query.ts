"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isNotDeployedError } from "./engine-client";
import { toActionError } from "./errors";

export type EngineQueryState<T> =
  | { status: "loading" }
  | { status: "ok"; value: T; fetchedAt: number }
  | { status: "not_deployed"; detail: string }
  | { status: "error"; message: string; retryable: boolean };

/**
 * Polls `fetcher` (every `pollMs`, default 15 s) while `enabled`, keeping the last good value on
 * screen during refreshes. A "not deployed" error is a calm state, not a failure. `fetcher` must
 * be referentially stable (wrap it in `useCallback`): a new function restarts the query.
 */
export function useEngineQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: { pollMs?: number; enabled?: boolean } = {},
): { state: EngineQueryState<T>; refresh: () => Promise<void>; refreshing: boolean } {
  const { pollMs = 15_000, enabled = true } = options;
  const [state, setState] = useState<EngineQueryState<T>>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    try {
      const value = await fetcher(controller.signal);
      if (controller.signal.aborted) return;
      setState({ status: "ok", value, fetchedAt: Date.now() });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isNotDeployedError(error)) {
        setState({ status: "not_deployed", detail: error instanceof Error ? error.message : "Not deployed yet." });
      } else {
        const described = toActionError(error);
        setState((previous) => (previous.status === "ok" ? previous : { status: "error", message: described.message, retryable: described.retryable }));
      }
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }, [fetcher]);

  useEffect(() => {
    if (!enabled) return;
    const first = window.setTimeout(() => void run(), 0);
    const timer = window.setInterval(() => void run(), pollMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      controllerRef.current?.abort();
    };
  }, [enabled, pollMs, run]);

  return { state, refresh: run, refreshing };
}
