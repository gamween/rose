import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A keyboard key hint, drawn as a tiny key block. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-ink-700 bg-ink-850 px-1 font-sans text-[10.5px] leading-none text-ink-300 shadow-[0_1px_0_0_var(--color-ink-950)] font-medium",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
