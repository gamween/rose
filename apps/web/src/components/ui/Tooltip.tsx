"use client";

import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Tooltip shown on hover (after a short delay), keyboard focus and tap, linked with
 * `aria-describedby` and mounted only while shown (its text never leaks into the surrounding
 * content); Escape hides it. `interactive` keeps it open while the pointer is over the
 * panel, for tooltips holding a link.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  interactive = false,
  className,
}: {
  content: ReactNode;
  children: (props: { "aria-describedby": string }) => ReactElement;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  interactive?: boolean;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pointer = useRef<string>("mouse");
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = (delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };
  return (
    <span
      className={cn("relative inline", className)}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") show(120);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") hide();
      }}
      onPointerDown={(event) => {
        pointer.current = event.pointerType;
      }}
      onClick={(event) => {
        if (pointer.current !== "mouse" && !(event.target instanceof Element && event.target.closest("[role=tooltip]"))) setOpen((value) => !value);
      }}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) show(0);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hide();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") hide();
      }}
    >
      {children({ "aria-describedby": id })}
      {open ? (
        <span
          id={id}
          role="tooltip"
          className={cn(
            "absolute z-50 w-max max-w-72 animate-rise-in",
            side === "top" ? "bottom-full pb-1.5" : "top-full pt-1.5",
            align === "center" && "left-1/2 -translate-x-1/2",
            align === "start" && "left-0",
            align === "end" && "right-0",
            !interactive && "pointer-events-none",
          )}
        >
          <span className="block rounded-sm border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-left text-[12px] leading-snug font-normal text-ink-100 normal-case shadow-(--shadow-overlay)">
            {content}
          </span>
        </span>
      ) : null}
    </span>
  );
}
