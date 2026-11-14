"use client";

import { useEffect, useState } from "react";
import type { Deployment } from "@/components/docs/deployment";
import { Button } from "@/components/ui/Button";
import { formatUtcTime } from "@/lib/format";
import { CashTokensBlock, EngineKeysBlock, MpcLatencyBlock, RoseVaultBlock, SolanaBlock, VerificationsBlock, VersionsBlock } from "./blocks";

export const REFRESH_MS = 30_000;

/** Every block refreshes together every 30 s; the header shows when the last cycle started. */
export function StatusPage({ deployment }: { deployment: Deployment }) {
  const [cycle, setCycle] = useState<{ key: number; at: number | null }>({ key: 0, at: null });

  useEffect(() => {
    const first = window.setTimeout(() => setCycle({ key: 0, at: Date.now() }), 0);
    const timer = window.setInterval(() => setCycle((previous) => ({ key: previous.key + 1, at: Date.now() })), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  const props = { deployment, refreshKey: cycle.key };

  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 py-8 md:px-6 lg:py-10">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-ink-50">Status</h1>
          <p className="mt-1 text-[13px] text-ink-400">Read live from the three testnets in your browser, with no server in between.</p>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-ink-400">
          <p aria-live="polite">
            {cycle.at ? (
              <>
                Refreshed at <time dateTime={new Date(cycle.at).toISOString()} className="tabular text-ink-100">{formatUtcTime(cycle.at)}</time>, next
                in {REFRESH_MS / 1000} s
              </>
            ) : (
              "Loading…"
            )}
          </p>
          <Button variant="secondary" size="sm" onClick={() => setCycle((previous) => ({ key: previous.key + 1, at: Date.now() }))}>
            Refresh now
          </Button>
        </div>
      </header>
      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
        <EngineKeysBlock {...props} />
        <VersionsBlock {...props} />
        <MpcLatencyBlock {...props} className="md:col-span-2" />
        <RoseVaultBlock {...props} />
        <SolanaBlock {...props} />
        <CashTokensBlock {...props} />
        <VerificationsBlock {...props} />
      </div>
    </main>
  );
}
