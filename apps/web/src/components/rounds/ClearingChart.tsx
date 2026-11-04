"use client";

/**
 * Supply and demand curves animating into the clearing price (spec 8.3). Two fixed series
 * (demand in ember, supply in blue, the validated chart palette of the Prices page), step lines
 * over the price axis, a reference line at `P*` with the traded volume, a crosshair tooltip on
 * hover and keyboard, and a table twin of the same steps. Numbers are converted to floats for
 * drawing only; the values shown come from the exact bigint steps.
 */

import { useEffect, useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { linearScale, useMeasure } from "@/components/prices/chart";
import { CHART_GRID, CHART_REFERENCE, CHART_SERIES, CHART_SURFACE, CHART_TEXT } from "@/components/prices/palette";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { cn } from "@/lib/cn";
import type { Curves, CurveStep } from "./curves";
import { formatQty, formatUsdc } from "./model";

const DEMAND = CHART_SERIES[0];
const SUPPLY = CHART_SERIES[1];
const MARGIN = { top: 20, right: 18, bottom: 32, left: 54 } as const;
const HEIGHT = 240;

function usdc(value: bigint): number {
  return Number(value) / 1e6;
}

function tokens(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

function compact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2);
}

function ticks(max: number, count: number): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function stepPath(steps: readonly CurveStep[], pick: (s: CurveStep) => bigint, x: (v: number) => number, y: (v: number) => number, decimals: number): string {
  let d = "";
  steps.forEach((step, index) => {
    const value = y(tokens(pick(step), decimals));
    const from = x(usdc(step.from));
    const to = x(usdc(step.to));
    d += index === 0 ? `M${from.toFixed(1)} ${value.toFixed(1)}` : `L${from.toFixed(1)} ${value.toFixed(1)}`;
    d += `L${to.toFixed(1)} ${value.toFixed(1)}`;
  });
  return d;
}

export interface ClearingChartProps {
  curves: Curves;
  decimals: number;
  kind: "Tender" | "Exit" | "Advance";
  clearing: { price: bigint; volume: bigint } | null;
  /** The round did not cross: the curves never meet. */
  noCrossing: boolean;
  className?: string;
}

export function ClearingChart({ curves, decimals, kind, clearing, noCrossing, className }: ClearingChartProps) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const id = useId();
  const [view, setView] = useState<"chart" | "table">("chart");
  const [hover, setHover] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setDrawn(true), 40);
    return () => window.clearTimeout(timer);
  }, [curves]);

  const demandLabel = kind === "Tender" ? "Issuer can afford" : kind === "Advance" ? "Funders' demand" : "Demand";
  const supplyLabel = kind === "Advance" ? "Holder's claim" : "Supply";
  const maxPrice = usdc(curves.maxPrice);
  const maxQty = Math.max(tokens(curves.maxQty, decimals), 1e-9);
  const x = useMemo(() => linearScale([0, maxPrice || 1], [MARGIN.left, Math.max(width, 320) - MARGIN.right]), [maxPrice, width]);
  const y = useMemo(() => linearScale([0, maxQty * 1.1], [HEIGHT - MARGIN.bottom, MARGIN.top]), [maxQty]);
  const w = Math.max(width, 320);
  const demandPath = useMemo(() => stepPath(curves.steps, (s) => s.demand, x, y, decimals), [curves.steps, decimals, x, y]);
  const supplyPath = useMemo(() => stepPath(curves.steps, (s) => s.supply, x, y, decimals), [curves.steps, decimals, x, y]);
  const xTicks = ticks(maxPrice, 6).filter((tick) => tick <= maxPrice);
  const yTicks = ticks(maxQty * 1.1, 4);
  const hovered = hover !== null ? curves.steps[hover] : undefined;

  const stepAtPrice = (price: number): number | null => {
    const index = curves.steps.findIndex((s) => price >= usdc(s.from) && price < usdc(s.to));
    if (index >= 0) return index;
    return curves.steps.length > 0 && price >= usdc(curves.steps[curves.steps.length - 1]?.from ?? 0n) ? curves.steps.length - 1 : null;
  };

  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * w;
    const price = ((px - MARGIN.left) / (w - MARGIN.left - MARGIN.right)) * maxPrice;
    setHover(stepAtPrice(price));
  };

  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "ArrowRight") setHover((h) => Math.min(curves.steps.length - 1, (h ?? -1) + 1));
    else if (event.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? 1) - 1));
    else if (event.key === "Escape") setHover(null);
    else return;
    event.preventDefault();
  };

  const clearingX = clearing ? x(usdc(clearing.price)) : null;
  const clearingY = clearing ? y(tokens(clearing.volume, decimals)) : null;
  const describe = clearing ? `Clearing price ${formatUsdc(clearing.price)} USDC, volume ${formatQty(clearing.volume, decimals)}.` : noCrossing ? "No price crosses the book." : "Not cleared yet.";

  return (
    <div className={cn("flex flex-col gap-2", className)} ref={ref} data-clearing-chart>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <ul className="flex items-center gap-4" aria-label="Series">
          <li className="flex items-center gap-1.5 text-ink-300">
            <span aria-hidden className="h-0.5 w-4" style={{ background: DEMAND }} />
            {demandLabel}
          </li>
          <li className="flex items-center gap-1.5 text-ink-300">
            <span aria-hidden className="h-0.5 w-4" style={{ background: SUPPLY }} />
            {supplyLabel}
          </li>
          {clearing ? (
            <li className="flex items-center gap-1.5 text-ink-300">
              <span aria-hidden className="h-3 w-px" style={{ background: CHART_REFERENCE }} />
              P*
            </li>
          ) : null}
          <li className="text-ink-400">quantities in tokens</li>
        </ul>
        <button type="button" className="font-display uppercase tracking-wide text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline" onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))} aria-pressed={view === "table"}>
          {view === "chart" ? "Table view" : "Chart view"}
        </button>
      </div>
      {view === "table" ? (
        <Table>
          <THead>
            <TR>
              <TH>Price interval (USDC)</TH>
              <TH numeric>{demandLabel}</TH>
              <TH numeric>{supplyLabel}</TH>
              <TH numeric>Volume</TH>
            </TR>
          </THead>
          <TBody>
            {curves.steps.map((step, index) => {
              const volume = step.demand < step.supply ? step.demand : step.supply;
              const holds = clearing !== null && clearing.price >= step.from && clearing.price < step.to;
              return (
                <TR key={index} className={holds ? "bg-ember-700/10" : undefined}>
                  <TD className="tabular">
                    {formatUsdc(step.from)} – {index === curves.steps.length - 1 ? "∞" : formatUsdc(step.to - 1n)}
                    {holds ? <span className="ml-2 font-display text-[10px] uppercase tracking-wide text-ember-300">P* here</span> : null}
                  </TD>
                  <TD numeric>{formatQty(step.demand, decimals)}</TD>
                  <TD numeric>{formatQty(step.supply, decimals)}</TD>
                  <TD numeric>{formatQty(volume, decimals)}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${String(w)} ${String(HEIGHT)}`}
            width="100%"
            height={HEIGHT}
            role="img"
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-desc`}
            tabIndex={0}
            onPointerMove={onPointer}
            onPointerLeave={() => setHover(null)}
            onKeyDown={onKey}
            className="block overflow-visible rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ember-400"
            style={{ background: CHART_SURFACE }}
          >
            <title id={`${id}-title`}>
              {demandLabel} and {supplyLabel} by price
            </title>
            <desc id={`${id}-desc`}>{describe} Use the arrow keys to move along the price intervals.</desc>
            <g aria-hidden>
              {yTicks.map((tick) => (
                <g key={`y${String(tick)}`}>
                  <line x1={MARGIN.left} x2={w - MARGIN.right} y1={y(tick)} y2={y(tick)} stroke={CHART_GRID} strokeWidth={1} />
                  <text x={MARGIN.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={11} fill={CHART_TEXT.muted} className="tabular">
                    {compact(tick)}
                  </text>
                </g>
              ))}
              {xTicks.map((tick) => (
                <text key={`x${String(tick)}`} x={x(tick)} y={HEIGHT - MARGIN.bottom + 16} textAnchor="middle" fontSize={11} fill={CHART_TEXT.muted} className="tabular">
                  {compact(tick)}
                </text>
              ))}
              <text x={w - MARGIN.right} y={HEIGHT - 4} textAnchor="end" fontSize={10} fill={CHART_TEXT.muted}>
                USDC per {kind === "Advance" ? "claimed" : "locked"} token
              </text>
            </g>
            <path d={demandPath} fill="none" stroke={DEMAND} strokeWidth={2} strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={drawn ? 0 : 1} style={{ transition: "stroke-dashoffset 900ms ease-out" }} />
            <path d={supplyPath} fill="none" stroke={SUPPLY} strokeWidth={2} strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={drawn ? 0 : 1} style={{ transition: "stroke-dashoffset 900ms ease-out 150ms" }} />
            {curves.steps.length > 0 ? (
              <g aria-hidden fontSize={11} className="tabular">
                <text x={x(usdc(curves.steps[0]?.from ?? 0n)) + 4} y={y(tokens(curves.steps[0]?.demand ?? 0n, decimals)) - 6} fill={CHART_TEXT.secondary}>
                  {demandLabel}
                </text>
                <text x={w - MARGIN.right - 4} y={y(tokens(curves.steps[curves.steps.length - 1]?.supply ?? 0n, decimals)) - 6} textAnchor="end" fill={CHART_TEXT.secondary}>
                  {supplyLabel}
                </text>
              </g>
            ) : null}
            {clearingX !== null && clearingY !== null ? (
              <g aria-hidden style={{ opacity: drawn ? 1 : 0, transform: drawn ? "translateX(0)" : `translateX(${String(MARGIN.left - clearingX)}px)`, transition: "opacity 500ms ease 1000ms, transform 900ms cubic-bezier(.2,.7,.2,1) 1000ms" }}>
                <line x1={clearingX} x2={clearingX} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke={CHART_REFERENCE} strokeWidth={1.5} strokeDasharray="4 3" />
                <line x1={MARGIN.left} x2={clearingX} y1={clearingY} y2={clearingY} stroke={CHART_REFERENCE} strokeWidth={1} strokeDasharray="2 3" opacity={0.7} />
                <circle cx={clearingX} cy={clearingY} r={5} fill={CHART_REFERENCE} stroke={CHART_SURFACE} strokeWidth={2} />
                <text x={clearingX + (clearingX > w / 2 ? -6 : 6)} y={MARGIN.top + 10} textAnchor={clearingX > w / 2 ? "end" : "start"} fontSize={11} fill={CHART_TEXT.primary} className="tabular">
                  P* {clearing ? formatUsdc(clearing.price) : ""}
                </text>
                <text x={clearingX + (clearingX > w / 2 ? -6 : 6)} y={MARGIN.top + 24} textAnchor={clearingX > w / 2 ? "end" : "start"} fontSize={11} fill={CHART_TEXT.secondary} className="tabular">
                  vol {clearing ? formatQty(clearing.volume, decimals) : ""}
                </text>
              </g>
            ) : null}
            {hovered ? (
              <g aria-hidden>
                <rect x={x(usdc(hovered.from))} width={Math.max(1, x(usdc(hovered.to)) - x(usdc(hovered.from)))} y={MARGIN.top} height={HEIGHT - MARGIN.top - MARGIN.bottom} fill={CHART_TEXT.primary} opacity={0.06} />
                <circle cx={x(usdc(hovered.from))} cy={y(tokens(hovered.demand, decimals))} r={4} fill={DEMAND} stroke={CHART_SURFACE} strokeWidth={2} />
                <circle cx={x(usdc(hovered.from))} cy={y(tokens(hovered.supply, decimals))} r={4} fill={SUPPLY} stroke={CHART_SURFACE} strokeWidth={2} />
              </g>
            ) : null}
          </svg>
          <div role="status" aria-live="polite" className={cn("pointer-events-none absolute left-[54px] top-2 rounded-sm border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-ink-100 shadow-lg transition-opacity", hovered ? "opacity-100" : "opacity-0")}>
            {hovered ? (
              <span className="tabular">
                {formatUsdc(hovered.from)}
                {hovered.to > hovered.from + 1n ? ` – ${formatUsdc(hovered.to - 1n)}` : ""} USDC · {demandLabel.toLowerCase()} {formatQty(hovered.demand, decimals)} · {supplyLabel.toLowerCase()} {formatQty(hovered.supply, decimals)}
              </span>
            ) : null}
          </div>
        </div>
      )}
      <p className="text-[11px] text-ink-400">{describe}</p>
    </div>
  );
}
