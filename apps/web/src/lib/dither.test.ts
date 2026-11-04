import { describe, expect, it } from "vitest";
import { EMBER_PALETTE, bayer8At, bayerMatrix, hexToRgb, nearestPaletteIndex } from "./dither";

describe("ordered dithering", () => {
  it("builds Bayer matrices that are permutations of 0..n-1", () => {
    for (const size of [2, 4, 8] as const) {
      const values = bayerMatrix(size).map((v) => Math.round(v * size * size)).sort((a, b) => a - b);
      expect(values).toEqual(Array.from({ length: size * size }, (_, i) => i));
    }
  });

  it("matches the bit-interleaved formula used in the dither shader", () => {
    const matrix = bayerMatrix(8);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        expect(bayer8At(x, y)).toBeCloseTo(matrix[y * 8 + x]!, 10);
      }
    }
  });

  it("maps colors to their nearest palette entry", () => {
    const palette = EMBER_PALETTE.map(hexToRgb);
    expect(nearestPaletteIndex([0, 0, 0], palette)).toBe(0);
    expect(EMBER_PALETTE[nearestPaletteIndex([255, 160, 60], palette)]).toBe("#ff9a3d");
  });
});
