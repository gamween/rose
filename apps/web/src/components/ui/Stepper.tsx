"use client";

import { cn } from "@/lib/cn";

export type StepperStep<T extends string> = { id: T; label: string };

/**
 * The numbered steps of a create flow (launchpad style): every step is a button, the current one
 * is ember, the earlier ones read as done. Below `sm` only the current step's name shows beside
 * the pips, so the row never scrolls sideways. Pair it with one panel at a time and Back /
 * Continue buttons under the panel.
 *
 * ```tsx
 * <Stepper steps={STEPS} value={step} onChange={setStep} label="Issuer steps" />
 * ```
 */
export function Stepper<T extends string>({ steps, value, onChange, label, className }: { steps: readonly StepperStep<T>[]; value: T; onChange: (id: T) => void; label: string; className?: string }) {
  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === value),
  );
  const current = steps[currentIndex];
  return (
    <nav aria-label={label} className={cn("flex flex-col gap-2", className)} data-stepper>
      <ol className="flex items-center gap-1.5 sm:gap-0">
        {steps.map((step, index) => {
          const state = index === currentIndex ? "current" : index < currentIndex ? "done" : "upcoming";
          return (
            <li key={step.id} className={cn("flex items-center", index < steps.length - 1 && "sm:flex-1")}>
              <button
                type="button"
                onClick={() => onChange(step.id)}
                aria-current={state === "current" ? "step" : undefined}
                aria-label={`Step ${String(index + 1)}: ${step.label}`}
                data-step-id={step.id}
                data-step-state={state}
                className="group flex items-center gap-2 rounded-sm py-1 pr-2 text-left outline-offset-2"
              >
                <span
                  className={cn(
                    "tabular flex size-6 shrink-0 items-center justify-center rounded-sm border text-[11px] font-medium transition-colors",
                    state === "current" && "border-ember-500 bg-ember-500 text-ink-950",
                    state === "done" && "border-ink-500 bg-ink-700 text-ink-100",
                    state === "upcoming" && "border-ink-700 bg-ink-900 text-ink-400 group-hover:border-ink-500",
                  )}
                >
                  {index + 1}
                </span>
                <span className={cn("hidden whitespace-nowrap text-[13px] font-medium sm:inline", state === "current" ? "text-ink-50" : "text-ink-400 group-hover:text-ink-100")}>{step.label}</span>
              </button>
              {index < steps.length - 1 ? <span aria-hidden className={cn("mx-1 hidden h-px flex-1 sm:block", index < currentIndex ? "bg-ink-500" : "bg-ink-750")} /> : null}
            </li>
          );
        })}
      </ol>
      {current ? (
        <p className="text-[12px] text-ink-400 sm:hidden">
          Step {currentIndex + 1} of {steps.length} · <span className="text-ink-100">{current.label}</span>
        </p>
      ) : null}
    </nav>
  );
}
