import Link from "next/link";
import { VoxelArt, type VoxelPreset } from "@/components/ui/VoxelArt";
import { ROUTES } from "@/lib/routes";

const ROUND_TYPES: { name: string; preset: VoxelPreset; line: string }[] = [
  {
    name: "Tender",
    preset: "tender",
    line: "An issuer posts a public budget and max price, holders submit sealed asks, and every filled seller is paid one uniform price.",
  },
  {
    name: "Exit",
    preset: "exit",
    line: "Holders of the same allocation and buyers bid sealed; one uniform price clears where supply meets demand, with no dumping.",
  },
  {
    name: "Advance",
    preset: "advance",
    line: "A holder sells a senior claim on the first tokens to unlock to sealed funders, with no oracle and no liquidation.",
  },
];

export function HowItWorks() {
  return (
    <section aria-labelledby="how-rose-works" className="border-t border-ink-750 bg-ink-950">
      <div className="mx-auto max-w-[1440px] px-4 py-16 md:px-6 md:py-24">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 id="how-rose-works" className="font-display text-[22px] text-ink-50 md:text-[28px]">
              How rose works
            </h2>
            <p className="mt-2 max-w-xl text-[14px] text-ink-300">
              Sealed rounds for locked allocations. Bids are encrypted until the round closes, the clearing price is computed on
              NEAR, and positions never leave Base or Solana.
            </p>
          </div>
          <Link
            href={ROUTES.docs}
            className="font-display text-[12px] uppercase tracking-wide text-ember-300 underline-offset-4 hover:underline"
          >
            Read the docs →
          </Link>
        </div>
        <ol className="mt-10 grid gap-px overflow-hidden rounded-lg border border-ink-750 bg-ink-750 md:grid-cols-3">
          {ROUND_TYPES.map((round, index) => (
            <li key={round.name} className="flex gap-4 bg-ink-900 p-5 md:flex-col md:gap-5 md:p-6">
              <div className="flex h-16 w-20 shrink-0 items-end md:h-20 md:w-auto">
                <VoxelArt preset={round.preset} size={72} />
              </div>
              <div>
                <h3 className="flex items-baseline gap-2 font-display text-[16px] text-ink-50">
                  <span aria-hidden className="tabular text-[11px] text-ink-500">0{index + 1}</span>
                  {round.name}
                </h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-300">{round.line}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
