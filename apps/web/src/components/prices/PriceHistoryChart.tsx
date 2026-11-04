"use client";

import Link from "next/link";
import { useId, useState, type PointerEvent } from "react";
import { Axes, ChartTable, ChartTooltip, formatDay, LegendItem, linearScale, MARGIN, Marker, useMeasure, type TooltipRow } from "./chart";
import { CHART_REFERENCE, type ChartShape } from "./palette";
import { compactNumber, distinctTicks, formatPercent, niceTicks, priceDomain, type ClassSeries, type PlottedPoint } from "./transforms";

const HEIGHT = 240;
const DAY_MS = 86_400_000;

function tooltipRows(point: PlottedPoint, color: string): TooltipRow[] {
  const rows: TooltipRow[] = [
    { label: "USDC per locked token", value: point.priceText, color },
    { label: `${point.kind} round`, value: `#${point.roundId}` },
    { label: "units traded", value: point.volumeText },
    { label: "remaining lock", value: `${compactNumber(point.remainingLockDays)} days` },
  ];
  if (point.referenceText !== null && point.discount !== null) {
    rows.push({ label: "issuer-declared reference", value: point.referenceText, color: CHART_REFERENCE });
    rows.push({ label: "discount to declared reference", value: formatPercent(point.discount) });
  }
  return rows;
}

/** Clearing price history of one class: a single line over settlement time, with a crosshair tooltip. */
export function PriceHistoryChart({ series, color, shape, symbol }: { series: ClassSeries; color: string; shape: ChartShape; symbol: string }) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const points = series.points;
  const times = points.map((point) => point.settledAtMs);
  const prices = points.map((point) => point.price);
  const references = points.flatMap((point) => (point.referencePrice === null ? [] : [point.referencePrice]));
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const xDomain: [number, number] = tMin === tMax ? [tMin - DAY_MS, tMax + DAY_MS] : [tMin - (tMax - tMin) * 0.05, tMax + (tMax - tMin) * 0.05];
  const yDomain = priceDomain([...prices, ...references]);
  const plotWidth = Math.max(width, 240);
  const x = linearScale(xDomain, [MARGIN.left, plotWidth - MARGIN.right]);
  const y = linearScale(yDomain, [HEIGHT - MARGIN.bottom, MARGIN.top]);
  const yTicks = niceTicks(yDomain[0], yDomain[1], 5).filter((tick) => tick <= yDomain[1]);
  const xTicks = distinctTicks(
    niceTicks(xDomain[0], xDomain[1], Math.max(3, Math.min(6, Math.floor(plotWidth / 110)))).filter((tick) => tick >= xDomain[0] && tick <= xDomain[1]),
    formatDay,
  );
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.settledAtMs).toFixed(1)} ${y(point.price).toFixed(1)}`).join(" ");
  const area = points.length > 1 ? `${path} L${x(points[points.length - 1]!.settledAtMs).toFixed(1)} ${y(0)} L${x(points[0]!.settledAtMs).toFixed(1)} ${y(0)} Z` : "";

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * plotWidth;
    let best = 0;
    let bestDistance = Infinity;
    points.forEach((point, index) => {
      const distance = Math.abs(x(point.settledAtMs) - px);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    setActive(best);
  };

  const activePoint = active === null ? null : (points[active] ?? null);

  return (
    <figure aria-labelledby={titleId} className="min-w-0">
      <figcaption id={titleId} className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] text-ink-50">
          {symbol} <span className="text-ink-400">· {series.label}</span>
        </span>
        <span className="tabular text-[12px] text-ink-400">
          last {points[points.length - 1]!.priceText} USDC · {points.length} settled round{points.length === 1 ? "" : "s"}
        </span>
      </figcaption>
      <ul className="mb-2 flex flex-wrap gap-x-5 gap-y-1" aria-label="Marks">
        <LegendItem color={color} shape={shape} label="USDC per locked token at settlement" />
        {references.length > 0 ? <LegendItem color={CHART_REFERENCE} shape="circle" hollow label="Issuer-declared reference (Tender)" /> : null}
      </ul>
      <div ref={ref} className="relative">
        <svg
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${plotWidth} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Clearing price history, ${points.length} settled rounds, last ${points[points.length - 1]!.priceText} USDC per locked token`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
          className="block overflow-visible"
        >
          <Axes width={plotWidth} height={HEIGHT} yTicks={yTicks} xTicks={xTicks} x={x} y={y} formatX={formatDay} />
          {area ? <path d={area} fill={color} fillOpacity={0.07} /> : null}
          {path ? <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
          {activePoint ? (
            <line x1={x(activePoint.settledAtMs)} x2={x(activePoint.settledAtMs)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke={color} strokeOpacity={0.5} strokeWidth={1} />
          ) : null}
          {points.map((point, index) =>
            point.referencePrice !== null ? (
              <g key={`ref-${point.roundId}`} aria-hidden>
                <line x1={x(point.settledAtMs)} x2={x(point.settledAtMs)} y1={y(point.price)} y2={y(point.referencePrice)} stroke={CHART_REFERENCE} strokeOpacity={0.6} strokeWidth={1} />
                <Marker shape="circle" cx={x(point.settledAtMs)} cy={y(point.referencePrice)} color={CHART_REFERENCE} size={index === active ? 12 : 10} hollow />
              </g>
            ) : null,
          )}
          {points.map((point, index) => (
            <Link
              key={point.roundId}
              href={`/app/rounds/${point.roundId}`}
              aria-label={`Round ${point.roundId}: ${point.priceText} USDC per locked token on ${formatDay(point.settledAtMs)}`}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className="outline-none"
            >
              <circle cx={x(point.settledAtMs)} cy={y(point.price)} r={14} fill="transparent" />
              <Marker shape={shape} cx={x(point.settledAtMs)} cy={y(point.price)} color={color} size={index === active ? 12 : 10} />
            </Link>
          ))}
        </svg>
        {activePoint ? (
          <ChartTooltip
            x={(x(activePoint.settledAtMs) / plotWidth) * (width || plotWidth)}
            y={y(activePoint.price)}
            width={width || plotWidth}
            title={`Settled ${formatDay(activePoint.settledAtMs)}`}
            rows={tooltipRows(activePoint, color)}
          />
        ) : null}
      </div>
      <ChartTable
        caption={`Clearing prices of ${series.label}`}
        columns={["Settled", "Round", "USDC per locked token", "Units", "Remaining lock", "Declared reference", "Discount"]}
        rows={points.map((point) => [
          new Date(point.settledAtMs).toLocaleDateString(),
          <Link key="round" href={`/app/rounds/${point.roundId}`} className="text-ember-300 hover:text-ember-200">
            #{point.roundId} {point.kind}
          </Link>,
          point.priceText,
          point.volumeText,
          `${compactNumber(point.remainingLockDays)} days`,
          point.referenceText ?? "—",
          point.discount === null ? "—" : formatPercent(point.discount),
        ])}
      />
    </figure>
  );
}
