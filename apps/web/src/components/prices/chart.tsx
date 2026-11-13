"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatUtcDay } from "@/lib/format";
import { CHART_GRID, CHART_SURFACE, CHART_TEXT, type ChartShape } from "./palette";
import { compactNumber } from "./transforms";

export const MARGIN = { top: 12, right: 16, bottom: 30, left: 46 } as const;

/** Width of a block element, tracked with a ResizeObserver (charts render for the width they have). */
export function useMeasure<T extends HTMLElement>(): { ref: React.RefObject<T | null>; width: number } {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function linearScale([d0, d1]: [number, number], [r0, r1]: [number, number]): (value: number) => number {
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** A series marker: 8px minimum, with a 2px ring in the surface color so overlaps stay legible. */
export function Marker({ shape, cx, cy, color, size = 8, hollow = false }: { shape: ChartShape; cx: number; cy: number; color: string; size?: number; hollow?: boolean }) {
  const r = size / 2;
  const fill = hollow ? CHART_SURFACE : color;
  const stroke = hollow ? color : CHART_SURFACE;
  const common = { fill, stroke, strokeWidth: 2, vectorEffect: "non-scaling-stroke" as const };
  switch (shape) {
    case "circle":
      return <circle cx={cx} cy={cy} r={r} {...common} />;
    case "square":
      return <rect x={cx - r} y={cy - r} width={size} height={size} {...common} />;
    case "diamond":
      return <path d={`M${cx} ${cy - r - 1}L${cx + r + 1} ${cy}L${cx} ${cy + r + 1}L${cx - r - 1} ${cy}Z`} {...common} />;
    case "triangle":
      return <path d={`M${cx} ${cy - r - 1}L${cx + r + 1} ${cy + r}L${cx - r - 1} ${cy + r}Z`} {...common} />;
    case "cross":
      return <path d={`M${cx - r} ${cy - r}L${cx + r} ${cy + r}M${cx + r} ${cy - r}L${cx - r} ${cy + r}`} stroke={color} strokeWidth={2.5} fill="none" />;
  }
}

/** Horizontal gridlines with y tick labels and x tick labels; hairline, solid, recessive. */
export function Axes({
  width,
  height,
  yTicks,
  xTicks,
  y,
  x,
  formatX,
  formatY = compactNumber,
}: {
  width: number;
  height: number;
  yTicks: number[];
  xTicks: number[];
  y: (value: number) => number;
  x: (value: number) => number;
  formatX: (value: number) => string;
  formatY?: (value: number) => string;
}) {
  return (
    <g aria-hidden>
      {yTicks.map((tick) => (
        <g key={`y-${tick}`}>
          <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(tick)} y2={y(tick)} stroke={CHART_GRID} strokeWidth={1} />
          <text x={MARGIN.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={11} fill={CHART_TEXT.muted} className="tabular">
            {formatY(tick)}
          </text>
        </g>
      ))}
      <line x1={MARGIN.left} x2={width - MARGIN.right} y1={height - MARGIN.bottom} y2={height - MARGIN.bottom} stroke={CHART_GRID} strokeWidth={1} />
      {xTicks.map((tick) => (
        <text key={`x-${tick}`} x={x(tick)} y={height - MARGIN.bottom + 16} textAnchor="middle" fontSize={11} fill={CHART_TEXT.muted} className="tabular">
          {formatX(tick)}
        </text>
      ))}
    </g>
  );
}

export type TooltipRow = { label: string; value: string; color?: string };

/** One tooltip for the hovered or focused mark; values lead, labels follow. */
export function ChartTooltip({ x, y, width, title, rows }: { x: number; y: number; width: number; title: string; rows: TooltipRow[] }) {
  const flip = x > width * 0.6;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 w-max max-w-64 rounded-md border border-ink-600 bg-ink-800 px-2.5 py-2 text-[12px] shadow-xl"
      style={{ left: x, top: y, transform: `translate(${flip ? "calc(-100% - 12px)" : "12px"}, -50%)` }}
    >
      <p className="mb-1 text-[12px] text-ink-300 font-medium">{title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dd className="tabular flex items-center gap-1.5 text-ink-50">
              {row.color ? <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: row.color }} /> : null}
              {row.value}
            </dd>
            <dt className="text-ink-400">{row.label}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function LegendItem({ color, shape, label, hollow = false }: { color: string; shape: ChartShape; label: ReactNode; hollow?: boolean }) {
  return (
    <li className="flex items-center gap-2 text-[12px] text-ink-300">
      <svg width="20" height="12" viewBox="0 0 20 12" aria-hidden>
        {hollow ? null : <line x1="0" x2="20" y1="6" y2="6" stroke={color} strokeWidth={2} />}
        <Marker shape={shape} cx={10} cy={6} color={color} size={7} hollow={hollow} />
      </svg>
      <span>{label}</span>
    </li>
  );
}

/** The table twin of a chart: every plotted value, reachable without hovering. */
export function ChartTable({ caption, columns, rows, className }: { caption: string; columns: string[]; rows: ReactNode[][]; className?: string }) {
  return (
    <details className={cn("mt-3 rounded-md border border-ink-750", className)}>
      <summary className="cursor-pointer px-3 py-1.5 text-[12px] text-ink-400 hover:text-ink-100 font-medium">Table view</summary>
      <div className="overflow-x-auto border-t border-ink-750">
        <table className="w-full border-collapse text-[12px]">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-ink-900">
            <tr>
              {columns.map((column, index) => (
                <th
                  key={column}
                  scope="col"
                  className={cn("px-3 py-1.5 text-[12px] text-ink-400 font-medium", index === 0 ? "text-left" : "text-right")}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-ink-800">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className={cn("px-3 py-1.5 text-ink-100", cellIndex === 0 ? "text-left" : "tabular text-right")}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export const formatDay = formatUtcDay;

export function formatDays(days: number): string {
  return `${compactNumber(days)}d`;
}
