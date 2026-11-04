import { EMBER_PALETTE, bayer8At, hexToRgb, nearestPaletteIndex } from "@/lib/dither";

const palette = EMBER_PALETTE.map(hexToRgb);

/**
 * Ember glow rising from the bottom of the frame, ordered-dithered (Bayer 8x8) to the ember
 * palette at `cell` pixels per dither cell: the same treatment as the landing post-processing.
 */
export function ditheredGlow(width: number, height: number, cell: number): Uint8Array {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cells = new Uint8Array(cols * rows * 3);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const dx = (x / cols - 0.72) * 1.6;
      const dy = (y / rows - 1.05) * 1.1;
      const glow = Math.exp(-(dx * dx + dy * dy) * 3.2);
      const heat = glow * glow;
      const target: [number, number, number] = [
        Math.min(255, 255 * (0.62 * glow + 0.38 * heat)),
        Math.min(255, 255 * (0.08 * glow + 0.42 * heat * heat)),
        Math.min(255, 255 * (0.05 * glow + 0.12 * heat * heat)),
      ];
      const threshold = bayer8At(x, y) - 0.5;
      const spread = 34;
      const shifted: [number, number, number] = [target[0] + threshold * spread, target[1] + threshold * spread, target[2] + threshold * spread];
      const color = palette[nearestPaletteIndex(shifted, palette)]!;
      cells.set(color, (y * cols + x) * 3);
    }
  }
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (Math.floor(y / cell) * cols + Math.floor(x / cell)) * 3;
      pixels.set(cells.subarray(source, source + 3), (y * width + x) * 3);
    }
  }
  return pixels;
}
