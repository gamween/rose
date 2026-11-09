import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { FlowStep } from "@/lib/use-action";
import { Button } from "./Button";
import { Spinner } from "./Spinner";

function StepMarker({ status, index }: { status: FlowStep["status"]; index: number }) {
  const base = "flex size-6 shrink-0 items-center justify-center rounded-sm border text-[11px] font-medium";
  switch (status) {
    case "running":
      return (
        <span className={cn(base, "border-ember-500 text-ember-400")}>
          <Spinner label="Running" />
        </span>
      );
    case "done":
      return (
        <span className={cn(base, "border-success-500/60 bg-success-500/10 text-success-400")} aria-label="Done">
          <svg viewBox="0 0 8 8" width="9" height="9" shapeRendering="crispEdges" aria-hidden>
            <path d="M0 4h1v1H0zM1 5h1v1H1zM2 6h1v1H2zM3 5h1v1H3zM4 4h1v1H4zM5 3h1v1H5zM6 2h1v1H6zM7 1h1v1H7z" fill="currentColor" />
          </svg>
        </span>
      );
    case "error":
      return (
        <span className={cn(base, "border-danger-500/60 bg-danger-500/10 text-danger-400")} aria-label="Failed">
          !
        </span>
      );
    default:
      return <span className={cn(base, "border-ink-700 text-ink-400")}>{index + 1}</span>;
  }
}

/**
 * The visible state of a multi-step flow (`useFlow`): every step with its live progress text,
 * explorer links, failure message and a Retry button that resumes from the failed step.
 */
export function FlowSteps({ steps, onRetry, running, className, footer }: { steps: FlowStep[]; onRetry?: () => void; running?: boolean; className?: string; footer?: ReactNode }) {
  if (steps.length === 0) return null;
  return (
    <ol className={cn("flex flex-col gap-3", className)} aria-label="Progress" data-flow-steps>
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-start gap-3" data-step={step.id} data-status={step.status}>
          <StepMarker status={step.status} index={index} />
          <div className="min-w-0 flex-1">
            <p className={cn("text-[13px]", step.status === "idle" ? "text-ink-400" : "text-ink-50")}>{step.label}</p>
            {step.detail ? <p className="mt-0.5 break-words text-[12px] text-ink-300">{step.detail}</p> : null}
            {step.error ? (
              <p className="mt-0.5 break-words text-[12px] text-danger-400" role="alert">
                {step.error.title}: {step.error.message}
              </p>
            ) : null}
            {step.links.length > 0 ? (
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {step.links.map((link) => (
                  <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="text-[12px] text-ember-300 underline-offset-2 hover:underline font-medium">
                    {link.label} ↗
                  </a>
                ))}
              </p>
            ) : null}
            {step.status === "error" && onRetry ? (
              <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry} disabled={running}>
                Retry this step
              </Button>
            ) : null}
          </div>
        </li>
      ))}
      {footer ? <li className="pl-9">{footer}</li> : null}
    </ol>
  );
}
