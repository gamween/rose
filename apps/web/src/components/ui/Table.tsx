"use client";

import { useRef, type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { useEdgeFade } from "./edge-fade";

/** A table that scrolls sideways when it is wider than its card (a phone), fading the edge that hides columns. */
export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  const scroller = useRef<HTMLDivElement>(null);
  const edgeFade = useEdgeFade(scroller);
  return (
    <div ref={scroller} className="w-full overflow-x-auto" style={edgeFade.style} data-overflow={edgeFade.overflow ? "true" : undefined}>
      <table className={cn("w-full border-collapse text-[13px]", className)} {...rest} />
    </div>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-ink-750 bg-ink-900/70", className)} {...rest} />;
}

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&>tr:not(:last-child)]:border-b [&>tr]:border-(--border-hairline)", className)} {...rest} />;
}

export function TR({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("transition-colors hover:bg-ink-800/50", className)} {...rest} />;
}

export function TH({ className, numeric, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "h-8 px-3 text-[11.5px] whitespace-nowrap text-ink-400 font-medium",
        numeric ? "text-right" : "text-left",
        className,
      )}
      {...rest}
    />
  );
}

export function TD({ className, numeric, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td className={cn("h-9 px-3 text-ink-100", numeric && "tabular text-right", className)} {...rest} />;
}
