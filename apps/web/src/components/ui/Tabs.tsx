"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type TabItem<T extends string> = { id: T; label: ReactNode; count?: number };

/** Accessible tab list (WAI-ARIA tabs pattern, arrow keys, Home and End). Panels use `tabPanelProps`. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const baseId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusAt = (index: number) => {
    const count = items.length;
    const next = ((index % count) + count) % count;
    refs.current[next]?.focus();
    const item = items[next];
    if (item) onChange(item.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") focusAt(index + 1);
    else if (event.key === "ArrowLeft") focusAt(index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(items.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    // The bottom rule is an inset shadow, not a border: the row scrolls sideways on a narrow screen
    // (labels never wrap) and the selected tab's underline still paints over the rule.
    <div role="tablist" aria-label={label} className={cn("flex items-center gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-ink-750)] [scrollbar-width:none]", className)}>
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`${baseId}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "relative flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[13px] font-medium transition-colors",
              selected ? "border-ember-500 text-ink-50" : "border-transparent text-ink-400 hover:border-ink-600 hover:text-ink-100",
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className={cn("tabular rounded-sm px-1 text-[11px] leading-4", selected ? "bg-ember-700/40 text-ember-200" : "bg-ink-800 text-ink-300")}>{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
