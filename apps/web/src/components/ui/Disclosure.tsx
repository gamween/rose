"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A collapsed section (native `<details>`: keyboard and screen readers for free) for secondary
 * content on screens without a "Details" tab, closed by default. The summary is one short line.
 * `defaultOpen` opens it (for example when a field inside needs attention); it never closes it
 * under the user, who alone collapses it.
 *
 * ```tsx
 * <Disclosure summary="Technical details"><DetailsList rows={rows} /></Disclosure>
 * ```
 */
export function Disclosure({ summary, children, defaultOpen = false, className }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [lastDefault, setLastDefault] = useState(defaultOpen);
  if (defaultOpen !== lastDefault) {
    setLastDefault(defaultOpen);
    if (defaultOpen) setOpen(true);
  }
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className={cn("group rounded-lg border border-ink-750 bg-ink-900", className)} data-disclosure>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-[13px] font-medium text-ink-200 transition-colors hover:text-ink-50 [&::-webkit-details-marker]:hidden">
        {summary}
        <svg viewBox="0 0 10 6" width="10" height="6" shapeRendering="crispEdges" className="shrink-0 text-ink-400 transition-transform group-open:rotate-180" aria-hidden>
          <path d="M0 0h2v2H0zM2 2h2v2H2zM4 4h2v2H4zM6 2h2v2H6zM8 0h2v2H8z" fill="currentColor" />
        </svg>
      </summary>
      <div className="border-t border-ink-750 px-4 py-3">{children}</div>
    </details>
  );
}
