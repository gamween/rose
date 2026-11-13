import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A mechanism in a few numbered steps, in one compact band under a page header (titles only on a phone). */
export function HowItWorks({ label, steps, className }: { label: string; steps: readonly { title: ReactNode; body: ReactNode }[]; className?: string }) {
  return (
    <ol aria-label={label} className={cn("ui-surface grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-ink-750 md:grid-flow-col md:auto-cols-fr md:grid-cols-none", className)} data-how-it-works>
      {steps.map((step, index) => (
        <li key={index} className="flex gap-3 bg-ink-850 px-4 py-3 last:odd:col-span-2 md:last:odd:col-span-1">
          <span aria-hidden className="tabular mt-px flex size-5 shrink-0 items-center justify-center rounded-[2px] border border-ink-700 bg-(--surface-inset) text-[11px] text-ember-300">
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="text-[13px] text-ink-50 font-medium">{step.title}</p>
            <p className="mt-0.5 hidden text-[12px] leading-snug text-ink-400 sm:block">{step.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
