import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SegmentedOption<T extends string | number> = { value: T; label: ReactNode; title?: string };

/**
 * A segmented control: one recessed track whose selected segment is a raised block. Each segment
 * is a toggle button (`aria-pressed`), so a filter can also be cleared by pressing it again.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  size = "sm",
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex w-fit rounded-md border border-ink-750 bg-(--surface-inset) shadow-[inset_0_1px_0_0_rgb(0_0_0/0.45)] max-w-full items-center gap-0.5 overflow-x-auto p-0.5 [scrollbar-width:none]", className)} {...rest}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            data-variant={active ? "secondary" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-3 font-medium",
              size === "sm" ? "h-7 text-[12.5px]" : "h-8 text-[13px]",
              active ? "ui-block border-ink-600 bg-ink-750 text-ink-50 [--face:1px]" : "text-ink-400 transition-colors hover:bg-ink-850 hover:text-ink-100",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
