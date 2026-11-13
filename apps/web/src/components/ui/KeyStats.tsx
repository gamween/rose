import type { ReactNode } from "react";
import type { GlossaryTerm } from "@/lib/glossary";
import { cn } from "@/lib/cn";
import { AnimatedNumber } from "./AnimatedNumber";
import { Term } from "./Term";

export type KeyStat = {
  /** Stable key and `data-stat` value (tests and anchors). */
  id: string;
  label: ReactNode;
  value: ReactNode;
  /** Unit after the value, smaller and muted (`USDC`, `units`). */
  unit?: ReactNode;
  /** One short muted line under the value. */
  hint?: ReactNode;
  /** Turns the label into a glossary `Term` (definition on hover, focus and tap). */
  term?: GlossaryTerm;
};

/**
 * The 3 or 4 numbers a screen leads with, as one strip of label / value pairs separated by
 * hairlines (two per row on a phone). Anything beyond four belongs in a `DetailsList`. String and
 * number values count up to their value (`AnimatedNumber`); pass a node for anything else.
 *
 * ```tsx
 * <KeyStats items={[
 *   { id: "max", label: "Max price", term: "maxPrice", value: "0.05", unit: "USDC" },
 *   { id: "orders", label: "Sealed orders", value: 2, hint: "1 bid, 1 ask" },
 * ]} />
 * ```
 */
export function KeyStats({ items, size = "md", className }: { items: readonly KeyStat[]; size?: "md" | "lg"; className?: string }) {
  const columns = items.length >= 4 ? "sm:grid-cols-4" : items.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <dl className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink-750 bg-ink-750", columns, className)} data-key-stats>
      {items.map((item) => (
        <div key={item.id} className="flex min-w-0 flex-col gap-1 bg-ink-900 px-3.5 py-3 sm:px-4" data-stat={item.id}>
          <dt className="text-[12px] text-ink-400 font-medium">{item.term ? <Term term={item.term} align="start">{item.label}</Term> : item.label}</dt>
          <dd className="flex flex-wrap items-baseline gap-x-1.5">
            <span className={cn("tabular min-w-0 leading-tight tracking-tight text-ink-50 [overflow-wrap:anywhere]", size === "lg" ? "text-[24px]" : "text-[18px]")}>
              {typeof item.value === "string" || typeof item.value === "number" ? <AnimatedNumber value={String(item.value)} /> : item.value}
            </span>
            {item.unit ? <span className="tabular text-[12px] text-ink-400">{item.unit}</span> : null}
          </dd>
          {item.hint ? <dd className="text-[12px] leading-snug text-ink-400">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
