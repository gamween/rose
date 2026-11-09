const PHRASE = "What was locked, rose.";
const ROSE_START = PHRASE.indexOf("rose");
const ROSE_END = ROSE_START + 4;

/** Native size of Departure Mono: one design pixel per canvas pixel. */
const FONT_PX = 11;
const LINE_ADVANCE = 14;
/** Voxels per design pixel along each axis, so a crack can run through a one-pixel stroke. */
export const TEXT_SUBDIVISION = 2;
/** Size of the chunks the letters break into, in design pixels. */
const CHUNK_CELL = 3.2;
/** Width of the fissures between chunks, in design pixels. */
const FISSURE_WIDTH = 0.6;

export type VoxelText = {
  count: number;
  /** xyz per voxel in design pixels, centered on the phrase, y up. */
  offsets: Float32Array;
  /** Per voxel: letter order in reading order (0..1), is part of "rose", random seed. */
  letters: Float32Array;
  /** Per voxel: on a fissure (0 or 1), chunk seed (0..1), chunk center xy (design pixels). */
  cracks: Float32Array;
  /**
   * Per voxel, which sides of its stroke it borders: x is +1 on the right edge of a stroke, -1 on
   * its left edge, 0 inside or on both; y the same for the top (+1) and bottom (-1) edges. The
   * shader chamfers the front faces along these edges so flat voxels still catch highlights.
   */
  edges: Float32Array;
  /** Bounds of the phrase in design pixels. */
  width: number;
  height: number;
  /** Center of each letter in the same space, in reading order. */
  letterCenters: { order: number; x: number; y: number }[];
};

/**
 * Rasterizes the phrase with the pixel display face and turns each lit pixel into
 * `TEXT_SUBDIVISION`² voxels, grouped into Voronoi chunks whose borders are the fissures that
 * glow when the fire cracks the letters. `lines` splits the phrase in two on narrow screens.
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
  const cells: number[] = [];
  const filled = new Set<number>();
  const cellKey = (gx: number, gy: number) => gy * 65536 + gx;
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
      for (let sy = 0; sy < TEXT_SUBDIVISION; sy += 1) {
        for (let sx = 0; sx < TEXT_SUBDIVISION; sx += 1) {
          const vx = x + (sx + 0.5) / TEXT_SUBDIVISION - 0.5;
          const vy = -(y + (sy + 0.5) / TEXT_SUBDIVISION - 0.5);
          offsets.push(vx, vy);
          letters.push(glyph.order, glyph.rose ? 1 : 0, hash(vx, vy));
          const gx = x * TEXT_SUBDIVISION + sx;
          const gy = y * TEXT_SUBDIVISION + sy;
          cells.push(gx, gy);
          filled.add(cellKey(gx, gy));
        }
      }
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
  const edges = new Float32Array(count * 2);
  const empty = (x: number, y: number) => (filled.has(cellKey(x, y)) ? 0 : 1);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = offsets[i * 2]! - cx;
    positions[i * 3 + 1] = offsets[i * 2 + 1]! - cy;
    const x = cells[i * 2]!;
    const y = cells[i * 2 + 1]!;
    edges[i * 2] = empty(x + 1, y) - empty(x - 1, y);
    edges[i * 2 + 1] = empty(x, y - 1) - empty(x, y + 1);
  }
  return {
    count,
    offsets: positions,
    letters: Float32Array.from(letters),
    cracks: crackPattern(positions, count),
    edges,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    letterCenters: centers.map(({ order, x, y }) => ({ order, x: x - cx, y: -y - cy })),
  };
}

/**
 * Voronoi chunks over the phrase: one jittered seed per `CHUNK_CELL` square, each voxel belongs
 * to its nearest seed, and voxels almost as close to a second seed sit on a fissure.
 */
function crackPattern(positions: Float32Array, count: number): Float32Array {
  const cracks = new Float32Array(count * 4);
  const seedOf = (i: number, j: number): [number, number] => [(i + 0.15 + 0.7 * hash(i, j)) * CHUNK_CELL, (j + 0.15 + 0.7 * hash(j + 31.7, i - 11.3)) * CHUNK_CELL];
  const chunkOf = new Int32Array(count);
  const sums = new Map<number, { x: number; y: number; n: number }>();
  for (let v = 0; v < count; v += 1) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const ci = Math.floor(x / CHUNK_CELL);
    const cj = Math.floor(y / CHUNK_CELL);
    let nearest = Infinity;
    let second = Infinity;
    let chunk = 0;
    for (let i = ci - 1; i <= ci + 1; i += 1) {
      for (let j = cj - 1; j <= cj + 1; j += 1) {
        const [sx, sy] = seedOf(i, j);
        const distance = Math.hypot(x - sx, y - sy);
        if (distance < nearest) {
          second = nearest;
          nearest = distance;
          chunk = (i + 4096) * 8192 + (j + 4096);
        } else if (distance < second) {
          second = distance;
        }
      }
    }
    chunkOf[v] = chunk;
    cracks[v * 4] = second - nearest < FISSURE_WIDTH ? 1 : 0;
    const sum = sums.get(chunk) ?? { x: 0, y: 0, n: 0 };
    sum.x += x;
    sum.y += y;
    sum.n += 1;
    sums.set(chunk, sum);
  }
  for (let v = 0; v < count; v += 1) {
    const chunk = chunkOf[v]!;
    const sum = sums.get(chunk)!;
    cracks[v * 4 + 1] = hash(chunk * 0.013, chunk * 0.007);
    cracks[v * 4 + 2] = sum.x / sum.n;
    cracks[v * 4 + 3] = sum.y / sum.n;
  }
  return cracks;
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

function hash(x: number, y: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return value - Math.floor(value);
}
