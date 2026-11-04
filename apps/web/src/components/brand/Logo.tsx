import { GLYPH_HEIGHT, GLYPH_PIXELS, GLYPH_WIDTH } from "./glyph";
import { cn } from "@/lib/cn";

export function RoseGlyph({ size = 20, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`}
      width={size}
      height={(size * GLYPH_HEIGHT) / GLYPH_WIDTH}
      shapeRendering="crispEdges"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {GLYPH_PIXELS.map(({ x, y, color }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} />
      ))}
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <RoseGlyph size={18} />
      <span className="font-display text-[17px] leading-none tracking-tight text-ink-50">rose</span>
    </span>
  );
}
