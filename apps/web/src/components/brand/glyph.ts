/** Pixel grid of the rose ember glyph (logo and favicon). Each letter is a palette key. */
export const GLYPH_ROWS = [
  ".....e.....",
  "....ed...e.",
  "...dcd..dd.",
  "..dccdd.cd.",
  ".dccbbecdc.",
  ".bcbeffbcb.",
  "bcbefffebcb",
  "bcbbfeebbcb",
  "abcbbbbbcba",
  "aabccccccaa",
  ".aabbbbbbaa",
  "...aaaaaa..",
] as const;

export const GLYPH_COLORS: Record<string, string> = {
  a: "#5c1420",
  b: "#9b1f2e",
  c: "#d8333c",
  d: "#f2622e",
  e: "#ff9a3d",
  f: "#ffcf7a",
};

export const GLYPH_WIDTH = GLYPH_ROWS[0].length;
export const GLYPH_HEIGHT = GLYPH_ROWS.length;

export type GlyphPixel = { x: number; y: number; color: string };

export const GLYPH_PIXELS: GlyphPixel[] = GLYPH_ROWS.flatMap((row, y) =>
  [...row].flatMap((key, x) => {
    const color = GLYPH_COLORS[key];
    return color ? [{ x, y, color }] : [];
  }),
);
