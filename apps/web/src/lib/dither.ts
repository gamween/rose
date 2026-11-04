/** Ember palette used by the landing dither pass, the Open Graph image and the voxel illustrations. */
export const EMBER_PALETTE = [
  "#050404",
  "#0f0c0b",
  "#1d1715",
  "#2f2622",
  "#4a3c35",
  "#7a6a5f",
  "#b5a596",
  "#1c080a",
  "#330d12",
  "#5c1420",
  "#9b1f2e",
  "#d8333c",
  "#f2622e",
  "#ff9a3d",
  "#ffcf7a",
  "#fff3dc",
] as const;

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Classic recursive Bayer matrix of size 2^n, values normalized to [0, 1). */
export function bayerMatrix(size: 2 | 4 | 8): number[] {
  let matrix = [0];
  let current = 1;
  while (current < size) {
    const next = current * 2;
    const grown = new Array<number>(next * next);
    for (let y = 0; y < current; y += 1) {
      for (let x = 0; x < current; x += 1) {
        const base = 4 * (matrix[y * current + x] ?? 0);
        grown[y * next + x] = base;
        grown[y * next + x + current] = base + 2;
        grown[(y + current) * next + x] = base + 3;
        grown[(y + current) * next + x + current] = base + 1;
      }
    }
    matrix = grown;
    current = next;
  }
  const cells = size * size;
  return matrix.map((value) => value / cells);
}

/** Index of the palette color closest to `color` with a weighted RGB metric. */
export function nearestPaletteIndex(color: Rgb, palette: readonly Rgb[]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((candidate, index) => {
    const dr = color[0] - candidate[0];
    const dg = color[1] - candidate[1];
    const db = color[2] - candidate[2];
    const distance = 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Bayer 8x8 threshold by bit interleaving, identical to the GLSL `bayer8` of the landing dither pass. */
export function bayer8At(x: number, y: number): number {
  const xx = x & 7;
  const yy = y & 7;
  const a = xx ^ yy;
  const v = ((a & 1) << 5) | ((yy & 1) << 4) | ((a & 2) << 2) | ((yy & 2) << 1) | ((a & 4) >> 1) | ((yy & 4) >> 2);
  return v / 64;
}
