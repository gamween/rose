"use client";

import Link from "next/link";
import { useId, useState, type PointerEvent } from "react";
import { Axes, ChartTable, ChartTooltip, formatDays, LegendItem, linearScale, MARGIN, Marker, useMeasure, type TooltipRow } from "./chart";
import { seriesColor, seriesShape } from "./palette";
import { compactNumber, dayDomain, formatPercent, niceTicks, priceDomain, type PlottedPoint, type TokenGroup } from "./transforms";

const HEIGHT = 300;
const HIT_RADIUS = 24;

type Dot = { point: PlottedPoint; seriesIndex: number; label: string };

/**
 * Price versus remaining lock time across the classes of one token. Series are told apart by
 * hue and marker shape (fixed order), a legend is always present, and the nearest dot within
 * 24px answers the pointer so nobody has to land on an 8px mark.
 */
export function LockScatterChart({ group }: { group: TokenGroup }) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const dots: Dot[] = group.series.flatMap((series, seriesIndex) => series.points.map((point) => ({ point, seriesIndex, label: series.label })));
  const xDomain = dayDomain(dots.map((dot) => dot.point.remainingLockDays));
  const yDomain = priceDomain(dots.map((dot) => dot.point.price));
  const plotWidth = Math.max(width, 240);
  const x = linearScale(xDomain, [MARGIN.left, plotWidth - MARGIN.right]);
  const y = linearScale(yDomain, [HEIGHT - MARGIN.bottom, MARGIN.top]);
  const yTicks = niceTicks(yDomain[0], yDomain[1], 5).filter((tick) => tick <= yDomain[1]);
  const xTicks = niceTicks(xDomain[0], xDomain[1], Math.max(4, Math.min(8, Math.floor(plotWidth / 90)))).filter((tick) => tick <= xDomain[1]);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = plotWidth / rect.width;
    const px = (event.clientX - rect.left) * scale;
    const py = (event.clientY - rect.top) * (HEIGHT / rect.height);
    let best: number | null = null;
    let bestDistance = HIT_RADIUS * scale;
    dots.forEach((dot, index) => {
      const distance = Math.hypot(x(dot.point.remainingLockDays) - px, y(dot.point.price) - py);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    setActive(best);
  };

  const activeDot = active === null ? null : (dots[active] ?? null);

  const rows = (dot: Dot): TooltipRow[] => {
    const list: TooltipRow[] = [
      { label: "USDC per locked token", value: dot.point.priceText, color: seriesColor(dot.seriesIndex) },
      { label: "remaining lock", value: `${compactNumber(dot.point.remainingLockDays)} days` },
      { label: `${dot.point.kind} round`, value: `#${dot.point.roundId}` },
      { label: "units traded", value: dot.point.volumeText },
    ];
    if (dot.point.discount !== null && dot.point.referenceText !== null) {
      list.push({ label: "issuer-declared reference", value: dot.point.referenceText });
      list.push({ label: "discount to declared reference", value: formatPercent(dot.point.discount) });
    }
    return list;
  };

  return (
    <figure aria-labelledby={titleId} className="min-w-0">
      <figcaption id={titleId} className="mb-2 text-[13px] text-ink-50">
        {group.symbol} <span className="text-ink-400">· USDC per locked token against the remaining lock (days) at settlement, every class on {group.chain}</span>
      </figcaption>
      <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1" aria-label="Classes">
        {group.series.map((series, index) => (
          <LegendItem key={series.classId} color={seriesColor(index)} shape={seriesShape(index)} label={series.label} />
        ))}
      </ul>
      <div ref={ref} className="relative">
        <svg
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${plotWidth} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Clearing price against remaining lock time for ${group.symbol}, ${dots.length} settled rounds across ${group.series.length} classes`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
          className="block overflow-visible"
        >
          <Axes width={plotWidth} height={HEIGHT} yTicks={yTicks} xTicks={xTicks} x={x} y={y} formatX={formatDays} />
          {dots.map((dot, index) => (
            <Link
              key={`${dot.point.roundId}-${dot.seriesIndex}`}
              href={`/app/rounds/${dot.point.roundId}`}
              aria-label={`Round ${dot.point.roundId}, ${dot.label}: ${dot.point.priceText} USDC per locked token with ${compactNumber(dot.point.remainingLockDays)} days of lock left`}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className="outline-none"
            >
              <Marker
                shape={seriesShape(dot.seriesIndex)}
                cx={x(dot.point.remainingLockDays)}
                cy={y(dot.point.price)}
                color={seriesColor(dot.seriesIndex)}
                size={index === active ? 12 : 10}
              />
            </Link>
          ))}
        </svg>
        {activeDot ? (
          <ChartTooltip
            x={(x(activeDot.point.remainingLockDays) / plotWidth) * (width || plotWidth)}
            y={y(activeDot.point.price)}
            width={width || plotWidth}
            title={activeDot.label}
            rows={rows(activeDot)}
          />
        ) : null}
      </div>
      <ChartTable
        caption={`Price versus remaining lock for ${group.symbol}`}
        columns={["Class", "Round", "Remaining lock", "USDC per locked token", "Units", "Discount to declared reference"]}
        rows={dots.map((dot) => [
          dot.label,
          <Link key="round" href={`/app/rounds/${dot.point.roundId}`} className="text-ember-300 hover:text-ember-200">
            #{dot.point.roundId} {dot.point.kind}
          </Link>,
          `${compactNumber(dot.point.remainingLockDays)} days`,
          dot.point.priceText,
          dot.point.volumeText,
          dot.point.discount === null ? "—" : formatPercent(dot.point.discount),
        ])}
      />
    </figure>
  );
}
