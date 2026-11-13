import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { NextStep } from "@/components/ui/NextStep";
import { Term } from "@/components/ui/Term";
import { VoxelArt, type VoxelPreset } from "@/components/ui/VoxelArt";
import { cn } from "@/lib/cn";
import { ROUTES } from "@/lib/routes";

/** The holder's path through rose, in the order a first visit takes it. */
export const HOLDER_PATH: readonly { title: string; body: string; href: string | null; art: VoxelPreset }[] = [
  { title: "Connect a NEAR wallet", body: "Units, cash and orders live on your NEAR account. A testnet wallet or the in-app demo wallet both work.", href: null, art: "vault" },
  { title: "Get test funds", body: "NEAR, Base Sepolia ETH, devnet SOL, test USDC and a demo vesting position, from the banner above.", href: null, art: "ember" },
  { title: "Deposit a position", body: "Put a locked stream in rose's custody; you receive its allocation as units of its class.", href: "/app/deposit", art: "ledger" },
  { title: "Join a round", body: "Sell your units, buy others', or answer an issuer's Tender, all with sealed orders.", href: ROUTES.rounds, art: "tender" },
];

/** First visit, no wallet: the four steps of the holder path, the first one live. */
export function GettingStarted({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-col gap-4" data-getting-started>
      <NextStep
        step={{ index: 1, total: HOLDER_PATH.length }}
        title="Connect a NEAR wallet"
        description={
          <>
            Your <Term term="unit">units</Term>, cash and sealed orders are read from your NEAR account. No wallet yet? The demo wallet creates a testnet account in this browser.
          </>
        }
        action={
          <Button onClick={onConnect} data-portfolio-connect>
            Connect NEAR
          </Button>
        }
      />
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="How rose works for a holder">
        {HOLDER_PATH.map((step, index) => {
          const body = (
            <>
              <div className="flex items-start justify-between gap-3 max-sm:hidden">
                <span className={cn("tabular flex size-6 items-center justify-center rounded-sm border text-[11px] font-medium", index === 0 ? "border-ember-500 bg-ember-700/25 text-ember-200" : "border-ink-700 bg-ink-900 text-ink-300")}>{index + 1}</span>
                <span className="hidden h-12 items-end sm:flex">
                  <VoxelArt preset={step.art} size={44} className={index === 0 ? undefined : "opacity-70 grayscale-[0.4]"} />
                </span>
              </div>
              <span className="mt-1 text-[13px] text-ink-50 font-semibold max-sm:mt-0">
                <span aria-hidden className="tabular mr-2 text-ink-500 sm:hidden">{index + 1}</span>
                {step.title}
              </span>
              <span className="text-[12px] leading-snug text-ink-400">{step.body}</span>
            </>
          );
          return (
            <li key={step.title} className="flex">
              {step.href ? (
                <Link href={step.href} className="ui-surface flex w-full flex-col gap-1 rounded-lg p-4 transition-colors hover:border-ink-600 hover:bg-ink-800/60">
                  {body}
                </Link>
              ) : (
                <div className="ui-surface flex w-full flex-col gap-1 rounded-lg p-4">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
