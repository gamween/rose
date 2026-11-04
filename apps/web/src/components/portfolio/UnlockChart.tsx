"use client";

import { ONE } from "@rose/sdk";
import { useId, useMemo, useState } from "react";
import { Axes, ChartTable, ChartTooltip, linearScale, MARGIN, useMeasure } from "@/components/prices/chart";
import { CHART_REFERENCE, CHART_SERIES, CHART_TEXT } from "@/components/prices/palette";
import { formatAmount, formatDate, formatDay, tokensAtFraction } from "@/lib/amounts";
import { scheduleBounds, timelinePoints, type EngineSchedule } from "@/lib/unlock-schedule";

const HEIGHT = 200;
const SERIES = CHART_SERIES[0];

export type UnlockChartProps = {
  schedule: EngineSchedule;
  decimals: number;
  /** When given, the y axis shows tokens of this many units instead of a percentage. */
  units?: bigint;
  symbol?: string;
  /** Unix seconds of "now"; defaults to the current time. */
  now?: number;
  title?: string;
  className?: string;
};

function percentLabel(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction < 0.1 && fraction > 0 ? 2 : 1)}%`;
}

/**
 * The unlock timeline of a class: `f(t)` sampled with the contract math (`@rose/sdk`) from the
 * schedule start to its end, as an area under a 2 px line (steps for Streamflow classes), with
 * the cliff and "now" marked, a crosshair tooltip and a table twin. One series, so no legend.
 */
export function UnlockChart({ schedule, decimals, units, symbol, now, title, className }: UnlockChartProps) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const titleId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [mountedAt] = useState(() => Math.floor(Date.now() / 1000));
  const nowSec = now ?? mountedAt;
  const points = useMemo(() => timelinePoints({ schedule, decimals }), [schedule, decimals]);
  const bounds = scheduleBounds(schedule);
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const chartWidth = Math.max(width, 280);
  const x = linearScale([first.t, last.t], [MARGIN.left, chartWidth - MARGIN.right]);
  const y = linearScale([0, 1], [HEIGHT - MARGIN.bottom, MARGIN.top]);
  const stepped = schedule.kind === "Stepped";
  const path = points
    .map((point, index) => {
      if (index === 0) return `M${x(point.t)} ${y(point.fraction)}`;
      const previous = points[index - 1];
      return stepped && previous ? `H${x(point.t)}V${y(point.fraction)}` : `L${x(point.t)} ${y(point.fraction)}`;
    })
    .join("");
  const area = `${path}L${x(last.t)} ${y(0)}L${x(first.t)} ${y(0)}Z`;
  const valueLabel = (fraction: number): string => {
    if (units === undefined) return percentLabel(fraction);
    const tokens = tokensAtFraction(units, BigInt(Math.round(fraction * 1_000_000)) * (ONE / 1_000_000n));
    return `${formatAmount(tokens, decimals, 2)}${symbol ? ` ${symbol}` : ""}`;
  };
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = [first.t, first.t + (last.t - first.t) * 0.25, first.t + (last.t - first.t) * 0.5, first.t + (last.t - first.t) * 0.75, last.t];
  const nowInRange = nowSec >= first.t && nowSec <= last.t;
  const hovered = hover === null ? null : points.reduce((best, point) => (Math.abs(point.t - hover) < Math.abs(best.t - hover) ? point : best), first);
  const caption = title ?? "Unlock timeline";

  return (
    <div ref={ref} className={className} data-unlock-chart>
      <div className="relative">
        <svg
          role="img"
          aria-labelledby={titleId}
          width={chartWidth}
          height={HEIGHT}
          viewBox={`0 0 ${String(chartWidth)} ${String(HEIGHT)}`}
          className="block max-w-full"
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const px = ((event.clientX - rect.left) / rect.width) * chartWidth;
            const t = first.t + ((px - MARGIN.left) / (chartWidth - MARGIN.left - MARGIN.right)) * (last.t - first.t);
            setHover(Math.min(last.t, Math.max(first.t, t)));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <title id={titleId}>{caption}: unlocked fraction from {formatDay(first.t * 1000)} to {formatDay(last.t * 1000)}</title>
          <Axes width={chartWidth} height={HEIGHT} yTicks={yTicks} xTicks={xTicks} y={y} x={x} formatX={(value) => formatDay(value * 1000)} formatY={(value) => `${String(Math.round(value * 100))}%`} />
          <path d={area} fill={SERIES} fillOpacity={0.14} />
          <path d={path} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {bounds.cliff !== null ? (
            <g aria-hidden>
              <line x1={x(Number(bounds.cliff))} x2={x(Number(bounds.cliff))} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke={CHART_TEXT.muted} strokeWidth={1} strokeDasharray="2 3" />
              <text x={x(Number(bounds.cliff)) + 4} y={MARGIN.top + 10} fontSize={10} fill={CHART_TEXT.secondary}>
                cliff
              </text>
            </g>
          ) : null}
          {nowInRange ? (
            <g aria-hidden>
              <line x1={x(nowSec)} x2={x(nowSec)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke={CHART_REFERENCE} strokeWidth={1} />
              <text x={x(nowSec) + 4} y={HEIGHT - MARGIN.bottom - 6} fontSize={10} fill={CHART_REFERENCE}>
                now
              </text>
            </g>
          ) : null}
          {hovered ? (
            <g aria-hidden>
              <line x1={x(hovered.t)} x2={x(hovered.t)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke={CHART_TEXT.muted} strokeWidth={1} />
              <circle cx={x(hovered.t)} cy={y(hovered.fraction)} r={4} fill={SERIES} stroke="#12100e" strokeWidth={2} />
            </g>
          ) : null}
        </svg>
        {hovered ? (
          <ChartTooltip
            x={(x(hovered.t) / chartWidth) * Math.max(width, 1)}
            y={(y(hovered.fraction) / HEIGHT) * HEIGHT}
            width={Math.max(width, 1)}
            title={formatDate(hovered.t * 1000)}
            rows={[
              { label: "unlocked", value: valueLabel(hovered.fraction), color: SERIES },
              ...(units !== undefined ? [{ label: "of", value: percentLabel(hovered.fraction) }] : []),
            ]}
          />
        ) : null}
      </div>
      <ChartTable
        caption={`${caption}, table`}
        columns={["Date", units === undefined ? "Unlocked" : `Unlocked${symbol ? ` (${symbol})` : ""}`, "Fraction"]}
        rows={[first, ...(bounds.cliff !== null ? [{ t: Number(bounds.cliff), fraction: points.find((point) => point.t === Number(bounds.cliff))?.fraction ?? 0 }] : []), { t: Math.min(Math.max(nowSec, first.t), last.t), fraction: hovered?.fraction ?? points.filter((point) => point.t <= nowSec).at(-1)?.fraction ?? 0 }, last].map((point) => [
          formatDate(point.t * 1000),
          valueLabel(point.fraction),
          percentLabel(point.fraction),
        ])}
      />
    </div>
  );
}
