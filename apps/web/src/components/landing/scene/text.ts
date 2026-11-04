const PHRASE = "What was locked, rose.";
const ROSE_START = PHRASE.indexOf("rose");
const ROSE_END = ROSE_START + 4;

/** Native size of Departure Mono: one design pixel per canvas pixel. */
const FONT_PX = 11;
const LINE_ADVANCE = 14;

export type VoxelText = {
  count: number;
  /** xy per voxel in voxel units, centered on the phrase, y up. */
  offsets: Float32Array;
  /** Per voxel: letter order in reading order (0..1), is part of "rose", random seed. */
  letters: Float32Array;
  width: number;
  height: number;
  /** Center of each letter in the same space, in reading order, for aiming the fire. */
  letterCenters: { order: number; x: number; y: number }[];
};

/**
 * Rasterizes the phrase with the pixel display face and turns each lit pixel into a voxel.
 * `lines` splits the phrase in two on narrow screens.
 */
export function buildVoxelText(fontFamily: string, lines: 1 | 2): VoxelText {
  const rows = lines === 1 ? [PHRASE] : [PHRASE.slice(0, ROSE_START - 1), PHRASE.slice(ROSE_START)];
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas unavailable");
  const font = `${FONT_PX}px ${fontFamily}`;
  context.font = font;
  const widths = rows.map((row) => Math.ceil(context.measureText(row).width));
  canvas.width = Math.max(...widths) + 4;
  canvas.height = rows.length * LINE_ADVANCE + 4;
  context.font = font;
  context.textBaseline = "alphabetic";

  const glyphCount = PHRASE.replace(/ /g, "").length;
  let charIndex = 0;
  let glyphIndex = 0;
  const glyphOrder = new Map<number, { order: number; rose: boolean }>();
  const centers: { order: number; x: number; y: number; id: number }[] = [];

  rows.forEach((row, line) => {
    const left = Math.round((canvas.width - (widths[line] ?? 0)) / 2);
    const baseline = 2 + line * LINE_ADVANCE + FONT_PX - 2;
    for (let i = 0; i < row.length; i += 1) {
      const char = row[i]!;
      const x = left + context.measureText(row.slice(0, i)).width;
      const advance = context.measureText(char).width;
      if (char !== " ") {
        const id = glyphIndex + 1;
        const order = (glyphIndex + 0.5) / glyphCount;
        const absolute = charIndex + i;
        glyphOrder.set(id, { order, rose: absolute >= ROSE_START && absolute < ROSE_END });
        context.fillStyle = `rgb(${id}, 0, 0)`;
        context.fillText(char, Math.round(x), baseline);
        centers.push({ order, x: x + advance / 2, y: baseline - FONT_PX / 3, id });
        glyphIndex += 1;
      }
    }
    charIndex += row.length + 1;
  });

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const offsets: number[] = [];
  const letters: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const p = (y * canvas.width + x) * 4;
      if ((pixels[p + 3] ?? 0) < 128) continue;
      const glyph = glyphOrder.get(pixels[p] ?? 0) ?? nearestGlyph(pixels[p] ?? 0, glyphOrder);
      if (!glyph) continue;
      offsets.push(x, -y);
      letters.push(glyph.order, glyph.rose ? 1 : 0, fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453));
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, -y);
      maxY = Math.max(maxY, -y);
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const count = offsets.length / 2;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = offsets[i * 2]! - cx;
    positions[i * 3 + 1] = offsets[i * 2 + 1]! - cy;
  }
  return {
    count,
    offsets: positions,
    letters: Float32Array.from(letters),
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    letterCenters: centers.map(({ order, x, y }) => ({ order, x: x - cx, y: -y - cy })),
  };
}

function nearestGlyph(red: number, glyphs: Map<number, { order: number; rose: boolean }>) {
  if (red === 0) return undefined;
  let best: { order: number; rose: boolean } | undefined;
  let bestDistance = Infinity;
  glyphs.forEach((value, id) => {
    const distance = Math.abs(id - red);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = value;
    }
  });
  return best;
}

function fract(value: number): number {
  return value - Math.floor(value);
}
