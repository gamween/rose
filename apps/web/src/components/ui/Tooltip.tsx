"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

/** Distance kept between the panel and the viewport edges, in pixels. */
const EDGE = 8;

/**
 * Tooltip shown on hover (after a short delay), keyboard focus and tap, linked with
 * `aria-describedby` and mounted only while shown (its text never leaks into the surrounding
 * content); Escape hides it. `interactive` keeps it open while the pointer is over the
 * panel, for tooltips holding a link. The panel is portalled to `document.body` and placed with
 * fixed coordinates, so an ancestor with `overflow: hidden` never clips it; it flips to the other
 * side when the preferred one has no room and stays inside the viewport horizontally.
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
  const [place, setPlace] = useState<{ left: number; top: number; side: "top" | "bottom" } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pointer = useRef<string>("mouse");
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const target = anchor.current?.getBoundingClientRect();
      const box = panel.current?.getBoundingClientRect();
      if (!target || !box) return;
      const roomAbove = target.top - box.height >= EDGE;
      const roomBelow = target.bottom + box.height <= window.innerHeight - EDGE;
      const placed = side === "top" ? (roomAbove || !roomBelow ? "top" : "bottom") : roomBelow || !roomAbove ? "bottom" : "top";
      const wanted = align === "start" ? target.left : align === "end" ? target.right - box.width : target.left + target.width / 2 - box.width / 2;
      const left = Math.max(EDGE, Math.min(wanted, window.innerWidth - box.width - EDGE));
      setPlace({ left, top: placed === "top" ? target.top - box.height : target.bottom, side: placed });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, side, align]);
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
      ref={anchor}
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
        if (!event.currentTarget.contains(event.relatedTarget) && !panel.current?.contains(event.relatedTarget)) hide();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") hide();
      }}
    >
      {children({ "aria-describedby": id })}
      {open
        ? createPortal(
            <span
              ref={panel}
              id={id}
              role="tooltip"
              style={{ position: "fixed", left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? "visible" : "hidden" }}
              className={cn(
                "z-[70] block w-max max-w-[min(18rem,calc(100vw-16px))] animate-rise-in",
                (place?.side ?? side) === "top" ? "pb-1.5" : "pt-1.5",
                !interactive && "pointer-events-none",
              )}
            >
              <span className="block rounded-sm border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-left text-[12px] leading-snug font-normal text-ink-100 normal-case shadow-(--shadow-overlay)">
                {content}
              </span>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
