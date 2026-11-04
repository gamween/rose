"use client";

import { missingDeployments } from "@/lib/deployment";

/** Testnet banner under the top bar with the "Get test funds" entry point. */
export function TestnetBanner({ onGetFunds }: { onGetFunds: () => void }) {
  const missing = missingDeployments();
  return (
    <div className="border-b border-ember-700/40 bg-ember-700/10" data-testnet-banner>
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 text-[12px] text-ink-200 md:px-6">
        <span className="flex items-center gap-2">
          <span aria-hidden className="size-[5px] animate-pulse bg-ember-400" />
          Testnet only: NEAR testnet, Base Sepolia, Solana devnet. Nothing here has value.
        </span>
        {missing.length > 0 ? <span className="text-ink-400">{missing.length === 8 ? "Contracts not deployed yet." : `${String(missing.length)} contracts not deployed yet.`}</span> : null}
        <button
          type="button"
          onClick={onGetFunds}
          data-get-funds
          className="ml-auto rounded-sm border border-ember-600 bg-ember-700/30 px-2 py-0.5 font-display text-[11px] uppercase tracking-wide text-ember-200 transition-colors hover:bg-ember-700/50"
        >
          Get test funds
        </button>
      </div>
    </div>
  );
}
