import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Stat({
  label,
  value,
  unit,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <dt className="font-display text-[11px] uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="tabular min-w-0 text-[22px] leading-tight text-ink-50 [overflow-wrap:anywhere]">{value}</span>
        {unit ? <span className="tabular text-[12px] text-ink-400">{unit}</span> : null}
      </dd>
      {hint ? <dd className="text-[12px] text-ink-400">{hint}</dd> : null}
    </div>
  );
}
