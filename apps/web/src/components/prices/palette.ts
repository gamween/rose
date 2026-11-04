/**
 * Chart colors for the dark ember surface (`--color-ink-850`, #12100e). Categorical slots are
 * assigned to classes in fixed order and never cycled; a fifth class folds into "Other" (gray)
 * and stays readable in the table. Validated with the dataviz palette validator on 2026-11-04:
 * all four slots inside OKLCH L 0.48-0.67, chroma >= 0.1, adjacent CVD Delta E >= 8, >= 3:1 on
 * the surface; the first three also pass the all-pairs check used for scatter plots.
 */
export const CHART_SERIES = ["#ec5a2a", "#4a8fd0", "#cf2c3b", "#3a9f63"] as const;

export const CHART_OTHER = "#7d7168";

/** Marker shapes paired with the hues (hue x shape), so identity never relies on color alone. */
export const CHART_SHAPES = ["circle", "square", "diamond", "triangle"] as const;

export type ChartShape = (typeof CHART_SHAPES)[number] | "cross";

export const CHART_TEXT = { primary: "#e9e1d9", secondary: "#a3978d", muted: "#918379" } as const;

export const CHART_GRID = "#201c19";

export const CHART_SURFACE = "#12100e";

export const CHART_REFERENCE = "#ffcf7a";

export function seriesColor(index: number): string {
  return CHART_SERIES[index] ?? CHART_OTHER;
}

export function seriesShape(index: number): ChartShape {
  return CHART_SHAPES[index] ?? "cross";
}
