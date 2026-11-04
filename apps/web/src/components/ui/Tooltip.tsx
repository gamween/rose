"use client";

import { useId, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Tooltip shown on hover and keyboard focus, linked with `aria-describedby`; Escape hides it. */
export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: {
  content: ReactNode;
  children: (props: { "aria-describedby": string }) => ReactElement;
  side?: "top" | "bottom";
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className={cn("relative inline-flex", className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      {children({ "aria-describedby": id })}
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 w-max max-w-64 -translate-x-1/2 rounded-sm border border-ink-600 bg-ink-800 px-2 py-1 text-[12px] leading-snug text-ink-100 shadow-lg transition-opacity duration-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          open ? "opacity-100" : "opacity-0",
        )}
      >
        {content}
      </span>
    </span>
  );
}
