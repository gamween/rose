"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import { USDC_DECIMALS, configuredEngineAccount, fetchEngineStats, type StatsResult } from "@/lib/engine";
import { formatCount, formatUnits } from "@/lib/format";

type ViewState = { status: "loading" } | { status: "error"; message: string } | StatsResult;

const REFRESH_MS = 30_000;

const NOT_DEPLOYED_DETAIL: Record<string, string> = {
  account_not_configured: "No engine account is configured for this deployment yet.",
  account_missing: "The configured engine account does not exist on NEAR testnet yet.",
  no_contract: "The engine account exists but no contract is deployed on it yet.",
  method_missing: "The deployed contract does not expose the stats view yet.",
};

/** Live protocol stats read from the engine `stats` view on NEAR testnet (no indexer, no cache). */
export function ProtocolStats() {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const account = configuredEngineAccount();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await fetchEngineStats(account, { signal });
      setState(result);
    } catch (error) {
      if (signal?.aborted) return;
      setState({ status: "error", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }, [account]);

  useEffect(() => {
    const controller = new AbortController();
    const first = window.setTimeout(() => void load(controller.signal), 0);
    const timer = window.setInterval(() => void load(controller.signal), REFRESH_MS);
    return () => {
      controller.abort();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  return (
    <section aria-labelledby="protocol-stats" className="border-t border-ink-750 bg-ink-950">
      <div className="mx-auto max-w-[1440px] px-4 py-16 md:px-6 md:py-20">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="protocol-stats" className="font-display text-[22px] text-ink-50 md:text-[28px]">
            Protocol
          </h2>
          <p className="text-[12px] text-ink-400">
            Read live from the engine contract on NEAR testnet{state.status === "ok" ? ` · block ${formatCount(state.blockHeight)}` : ""}
          </p>
        </div>
        <div className="mt-8 rounded-lg border border-ink-750 bg-ink-900" aria-live="polite" aria-busy={state.status === "loading"}>
          {state.status === "loading" ? (
            <dl className="grid grid-cols-2 gap-6 p-6 md:grid-cols-5">
              {["Rounds", "Settled rounds", "Settled volume", "Classes", "Positions"].map((label) => (
                <div key={label} className="flex flex-col gap-2">
                  <dt className="font-display text-[11px] uppercase tracking-wide text-ink-400">{label}</dt>
                  <dd>
                    <Skeleton className="h-7 w-24" />
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {state.status === "ok" ? (
            <dl className="grid grid-cols-2 gap-6 p-6 md:grid-cols-5">
              <Stat label="Rounds" value={formatCount(state.stats.roundsTotal)} />
              <Stat label="Settled rounds" value={formatCount(state.stats.roundsSettled)} />
              <Stat label="Settled volume" value={formatUnits(state.stats.volumeSettledUsdc, USDC_DECIMALS, 2)} unit="USDC" />
              <Stat label="Classes" value={formatCount(state.stats.classes)} />
              <Stat label="Positions" value={formatCount(state.stats.positions)} />
            </dl>
          ) : null}
          {state.status === "not_deployed" ? (
            <EmptyState
              illustration="ember"
              title="Protocol not deployed yet"
              description={`${NOT_DEPLOYED_DETAIL[state.reason]} Stats appear here, read directly from the contract, as soon as the engine is live.`}
            />
          ) : null}
          {state.status === "error" ? (
            <EmptyState
              illustration="ledger"
              title="Could not read the engine"
              description={state.message}
              action={
                <Button variant="secondary" size="sm" onClick={() => void load()}>
                  Retry
                </Button>
              }
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
