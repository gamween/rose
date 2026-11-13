"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { missingDeployments } from "@/lib/deployment";
import { ROUTES } from "@/lib/routes";

/** Testnet banner under the top bar with the "Get test funds" and "Watch a full round" entry points. */
export function TestnetBanner({ onGetFunds, demo }: { onGetFunds: () => void; demo: boolean }) {
  const missing = missingDeployments();
  return (
    <div className="relative border-b border-ink-750 bg-ink-900" data-testnet-banner>
      <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-ember-600/60 [mask-image:var(--dither-50)] [mask-size:2px_2px]" />
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 text-[12px] text-ink-200 md:px-6">
        <span className="flex items-center gap-2">
          <span aria-hidden className="size-[5px] shrink-0 animate-pixel-blink bg-ember-400" />
          Testnet only: NEAR testnet, Base Sepolia, Solana devnet. Nothing here has value.
        </span>
        {missing.length > 0 ? <span className="text-ink-400">{missing.length === 8 ? "Contracts not deployed yet." : `${String(missing.length)} contracts not deployed yet.`}</span> : null}
        {demo ? (
          <Link href={ROUTES.demo} data-watch-demo className="ml-auto text-[12px] text-ember-200 underline-offset-2 hover:underline font-medium">
            Watch a full round
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onGetFunds}
          data-get-funds
          data-variant="secondary"
          className={cn("ui-block h-6 rounded-sm px-2 text-[12px] text-ember-200 font-medium [--face:1px]", !demo && "ml-auto")}
        >
          Get test funds
        </button>
      </div>
    </div>
  );
}
