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
      <dd className="flex items-baseline gap-1.5">
        <span className="tabular truncate text-[22px] leading-tight text-ink-50">{value}</span>
        {unit ? <span className="tabular text-[12px] text-ink-400">{unit}</span> : null}
      </dd>
      {hint ? <dd className="text-[12px] text-ink-400">{hint}</dd> : null}
    </div>
  );
}
