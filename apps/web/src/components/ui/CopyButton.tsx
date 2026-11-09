"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/** A small square that copies `value` (an address, a hash, an id) and confirms with a pixel tick. */
export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1400);
    return () => window.clearTimeout(timer);
  }, [state]);
  const name = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <button
      type="button"
      aria-label={name}
      title={name}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        navigator.clipboard.writeText(value).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
      className={cn(
        "relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-sm align-middle transition-colors",
        state === "copied" ? "text-success-400" : state === "failed" ? "text-danger-400" : "text-ink-400 hover:bg-ink-800 hover:text-ink-100",
        className,
      )}
      data-copy
    >
      {state === "copied" ? (
        <svg viewBox="0 0 8 8" width="9" height="9" shapeRendering="crispEdges" aria-hidden>
          <path d="M0 4h1v1H0zM1 5h1v1H1zM2 6h1v1H2zM3 5h1v1H3zM4 4h1v1H4zM5 3h1v1H5zM6 2h1v1H6zM7 1h1v1H7z" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 10 10" width="10" height="10" shapeRendering="crispEdges" aria-hidden>
          <path d="M3 0h7v7H9V1H3zM0 3h7v7H0zM1 4v5h5V4z" fill="currentColor" fillRule="evenodd" />
        </svg>
      )}
    </button>
  );
}
