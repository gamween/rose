"use client";

/**
 * Where a round is in its lifecycle (spec 5.6): the compact five-step progress of the round
 * header (`RoundProgress`) and the full timeline of the Overview tab with the time and outcome of
 * each step (`StatusTimeline`). The next action itself lives in the action card (`RoundAction`).
 */

import { cn } from "@/lib/cn";
import { formatDateTime, timeline, type TimelineStep } from "./model";
import type { RoundDetail } from "./useRoundDetail";

function StepDot({ state }: { state: "done" | "active" | "upcoming" | "failed" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 flex size-3 items-center justify-center rounded-[1px] border",
        state === "done" && "border-success-500 bg-success-500 shadow-[0_2px_0_0_rgb(0_0_0/0.6)]",
        state === "active" && "border-ember-400 bg-ember-500 shadow-[0_0_0_3px_rgb(242_98_46/0.2),0_2px_0_0_var(--color-ember-700)]",
        state === "upcoming" && "border-ink-600 bg-(--surface-inset)",
        state === "failed" && "border-danger-500 bg-danger-500",
      )}
    >
      {state === "active" ? <span className="size-1 animate-pixel-blink bg-ink-950" /> : null}
    </span>
  );
}

function stepTone(step: TimelineStep): string {
  return step.state === "active" ? "text-ember-300" : step.state === "failed" ? "text-danger-400" : step.state === "done" ? "text-ink-200" : "text-ink-400";
}

/** The rail behind the steps: dithered ahead, solid behind the reached step. */
function Rail({ steps, className }: { steps: readonly TimelineStep[]; className?: string }) {
  const reached = steps.reduce((last, step, index) => (step.state === "done" || step.state === "active" ? index : last), -1);
  return (
    <>
      <span aria-hidden className={cn("absolute left-[10%] right-[10%] top-[5.5px] h-px bg-ink-600 [mask-image:var(--dither-50)] [mask-size:2px_2px]", className)} />
      <span aria-hidden className={cn("absolute left-[10%] top-[5.5px] h-px bg-success-500/60 transition-[width] duration-500", className)} style={{ width: `${String((Math.max(0, reached) / (steps.length - 1)) * 80)}%` }} />
    </>
  );
}

/** The five steps as one compact row for the round header: labels from `sm` up, the current step's label only on a phone. */
export function RoundProgress({ detail, nowMs }: { detail: RoundDetail; nowMs: number }) {
  const steps = timeline(detail.round, nowMs, detail.cls.decimals);
  return (
    <ol className="relative grid grid-cols-5 gap-1" aria-label="Round progress" data-progress>
      <Rail steps={steps} />
      {steps.map((step) => (
        <li key={step.id} className="flex min-w-0 flex-col items-center gap-1 text-center" data-step={step.id} data-state={step.state} aria-current={step.state === "active" ? "step" : undefined}>
          <StepDot state={step.state} />
          <span className={cn("text-[11px] font-medium", stepTone(step), step.state === "active" || step.state === "failed" ? "" : "max-sm:sr-only")}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** The full timeline (Overview tab): each step with its time and what happened, stacked on a phone. */
export function StatusTimeline({ detail, nowMs }: { detail: RoundDetail; nowMs: number }) {
  const steps = timeline(detail.round, nowMs, detail.cls.decimals);
  return (
    <section aria-label="Timeline" className="ui-surface rounded-lg px-4 py-4" data-timeline>
      <ol className="relative flex flex-col gap-3 sm:grid sm:grid-cols-5 sm:gap-2">
        <Rail steps={steps} className="max-sm:hidden" />
        {steps.map((step) => (
          <li key={step.id} className="flex min-w-0 items-start gap-3 sm:flex-col sm:items-center sm:gap-1.5 sm:text-center" data-step={step.id} data-state={step.state}>
            <span className="mt-0.5 sm:mt-0">
              <StepDot state={step.state} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={cn("text-[12px] font-medium", stepTone(step))}>{step.label}</span>
              <span className="tabular text-[11px] text-ink-400">{step.at !== null ? formatDateTime(step.at).replace(" UTC", "") : "—"}</span>
              {step.detail ? <span className="text-[11px] leading-tight text-ink-400">{step.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
