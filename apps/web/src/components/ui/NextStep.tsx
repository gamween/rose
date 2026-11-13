import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one thing to do now on a page, given the visitor's state: a short sentence, an optional
 * explanation and the button that does it. Its border carries a slow ember sweep (`.ui-shine`).
 * `step` numbers the path ("Step 2 of 4") when the page belongs to a sequence.
 */
export function NextStep({ title, description, action, step, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; step?: { index: number; total: number }; className?: string }) {
  return (
    <section
      aria-label="Next step"
      className={cn("ui-surface ui-shine relative flex flex-col gap-3 rounded-lg px-4 py-3 sm:flex-row sm:items-center sm:justify-between", className)}
      data-next-step
    >
      <div className="flex min-w-0 items-start gap-3">
        <svg viewBox="0 0 7 7" width="14" height="14" shapeRendering="crispEdges" aria-hidden className="mt-0.5 shrink-0 text-ember-400">
          <path d="M0 3h4v1H0zM3 1h1v2H3zM4 2h1v3H4zM5 3h1v1H5zM3 4h1v2H3z" fill="currentColor" />
        </svg>
        <div className="min-w-0">
          <p className="text-[11px] text-ember-300 font-medium">{step ? `Next step · ${String(step.index)} of ${String(step.total)}` : "Next step"}</p>
          <h2 className="text-[14px] text-ink-50 font-medium">{title}</h2>
          {description ? <p className="mt-0.5 text-[12.5px] leading-snug text-ink-400">{description}</p> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2 pl-[26px] sm:pl-0">{action}</div> : null}
    </section>
  );
}
