import { Button } from "@/components/ui/Button";
import { VoxelArt } from "@/components/ui/VoxelArt";
import { cn } from "@/lib/cn";

/** The holder's path through rose, in the order a first visit takes it. */
export const HOLDER_PATH = ["Connect a NEAR wallet", "Get test funds", "Deposit a position", "Join a round"] as const;

/** First visit, no wallet: one centered card with the one next step, and the holder path as a single numbered line. */
export function GettingStarted({ onConnect }: { onConnect: () => void }) {
  return (
    <section className="ui-surface flex flex-col items-center rounded-lg px-6 py-12 text-center" aria-labelledby="getting-started-title" data-getting-started>
      <div className="relative mb-5 flex items-center justify-center">
        <span aria-hidden className="dither-glow absolute size-28 opacity-60" />
        <VoxelArt preset="vault" size={88} className="relative" />
      </div>
      <h2 id="getting-started-title" className="text-[16px] font-semibold text-ink-50">
        Connect a NEAR wallet
      </h2>
      <p className="mt-1.5 max-w-sm text-[13px] text-ink-400">Your units, cash and sealed orders live on your NEAR account. The demo wallet works too.</p>
      <Button className="mt-5" size="lg" onClick={onConnect} data-portfolio-connect>
        Connect NEAR
      </Button>
      <ol className="mt-8 flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-[12px] text-ink-400" aria-label="How rose works for a holder">
        {HOLDER_PATH.map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            <span className={cn("tabular flex size-5 items-center justify-center rounded-sm border text-[11px]", index === 0 ? "border-ember-500 text-ember-200" : "border-ink-700 text-ink-400")}>{index + 1}</span>
            <span className={index === 0 ? "text-ink-100" : undefined}>{step}</span>
            {index < HOLDER_PATH.length - 1 ? (
              <span aria-hidden className="text-ink-600">
                ·
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
