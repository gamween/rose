export type Vec3 = readonly [number, number, number];

export type Bounds = { min: Vec3; max: Vec3 };

/**
 * Dense voxel grid storing a material id, a scalar and a part per cell. Shapes are rasterized by
 * stamping implicit primitives into the current `part`; a stamp never takes a cell from another
 * part (the first part to fill a cell keeps it), and `surface()` keeps every cell with a face on
 * empty space or on another part. Each part is then a closed shell of its own, so parts that move
 * apart never open a hole where they touched.
 */
export class VoxelGrid {
  readonly min: Vec3;
  readonly size: Vec3;
  readonly material: Uint8Array;
  readonly weight: Float32Array;
  readonly parts: Uint8Array;
  /** The part that subsequent stamps fill. */
  part = 0;

  constructor(bounds: Bounds) {
    this.min = bounds.min;
    this.size = [bounds.max[0] - bounds.min[0] + 1, bounds.max[1] - bounds.min[1] + 1, bounds.max[2] - bounds.min[2] + 1];
    const cells = this.size[0] * this.size[1] * this.size[2];
    this.material = new Uint8Array(cells);
    this.weight = new Float32Array(cells);
    this.parts = new Uint8Array(cells);
  }

  index(x: number, y: number, z: number): number {
    const ix = Math.round(x) - this.min[0];
    const iy = Math.round(y) - this.min[1];
    const iz = Math.round(z) - this.min[2];
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.size[0] || iy >= this.size[1] || iz >= this.size[2]) return -1;
    return ix + this.size[0] * (iy + this.size[1] * iz);
  }

  get(x: number, y: number, z: number): number {
    const i = this.index(x, y, z);
    return i < 0 ? 0 : (this.material[i] ?? 0);
  }

  /** Fills a cell of the current part; `overwrite` lets it replace a filled cell of the same part. */
  set(x: number, y: number, z: number, material: number, weight = 0, overwrite = true): void {
    const i = this.index(x, y, z);
    if (i < 0) return;
    if (this.material[i] !== 0 && (!overwrite || this.parts[i] !== this.part)) return;
    this.material[i] = material;
    this.weight[i] = weight;
    this.parts[i] = this.part;
  }

  /** Empties a cell, whatever part fills it. */
  clear(x: number, y: number, z: number): void {
    const i = this.index(x, y, z);
    if (i >= 0) this.material[i] = 0;
  }

  private exposed(i: number, x: number, y: number, z: number): boolean {
    const j = this.index(x, y, z);
    return j < 0 || this.material[j] === 0 || this.parts[j] !== this.parts[i];
  }

  /** Fills an axis-aligned ellipsoid. */
  ellipsoid(center: Vec3, radii: Vec3, material: number, weight = 0, overwrite = true): void {
    const [cx, cy, cz] = center;
    const [rx, ry, rz] = radii;
    for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z += 1) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
          const dx = (x - cx) / rx;
          const dy = (y - cy) / ry;
          const dz = (z - cz) / rz;
          if (dx * dx + dy * dy + dz * dz <= 1) this.set(x, y, z, material, weight, overwrite);
        }
      }
    }
  }

  /** Fills a tube along a polyline with linearly interpolated radius. `weightAt(t)` maps the curve parameter to the cell weight. */
  tube(
    points: readonly Vec3[],
    radii: readonly number[],
    material: number,
    weightAt: (t: number) => number = () => 0,
    overwrite = true,
  ): void {
    const samples = sampleCurve(points, 6);
    const last = samples.length - 1;
    samples.forEach((point, i) => {
      const t = last === 0 ? 0 : i / last;
      const radius = sampleRadius(radii, t);
      this.ellipsoid(point, [radius, radius, radius], material, weightAt(t), overwrite);
    });
  }

  /**
   * Rasterizes a thin triangle. `keep` can carve the triangle (for scalloped wing edges); `weight`
   * is either one value for every cell or a function of the cell.
   */
  triangle(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    material: number,
    keep: (u: number, v: number) => boolean = () => true,
    overwrite = false,
    weight: number | ((cell: Vec3) => number) = 0,
  ): void {
    const edge = Math.max(distance(a, b), distance(b, c), distance(c, a));
    const steps = Math.ceil(edge * 2.2);
    for (let i = 0; i <= steps; i += 1) {
      for (let j = 0; j <= steps - i; j += 1) {
        const u = i / steps;
        const v = j / steps;
        if (!keep(u, v)) continue;
        const w = 1 - u - v;
        const x = Math.round(a[0] * w + b[0] * u + c[0] * v);
        const y = Math.round(a[1] * w + b[1] * u + c[1] * v);
        const z = Math.round(a[2] * w + b[2] * u + c[2] * v);
        this.set(x, y, z, material, typeof weight === "number" ? weight : weight([x, y, z]), overwrite);
      }
    }
  }

  /** Calls `visit` for every filled cell with a face on empty space or on another part. */
  surface(visit: (x: number, y: number, z: number, material: number, weight: number) => void): void {
    const [sx, sy, sz] = this.size;
    for (let iz = 0; iz < sz; iz += 1) {
      for (let iy = 0; iy < sy; iy += 1) {
        for (let ix = 0; ix < sx; ix += 1) {
          const i = ix + sx * (iy + sy * iz);
          const material = this.material[i] ?? 0;
          if (material === 0) continue;
          const x = ix + this.min[0];
          const y = iy + this.min[1];
          const z = iz + this.min[2];
          const exposed =
            this.exposed(i, x + 1, y, z) ||
            this.exposed(i, x - 1, y, z) ||
            this.exposed(i, x, y + 1, z) ||
            this.exposed(i, x, y - 1, z) ||
            this.exposed(i, x, y, z + 1) ||
            this.exposed(i, x, y, z - 1);
          if (exposed) visit(x, y, z, material, this.weight[i] ?? 0);
        }
      }
    }
  }
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(a: Vec3): Vec3 {
  return scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
}

/** Distance from `point` to the segment from `a` to `b`. */
export function segmentDistance(point: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const t = Math.min(1, Math.max(0, dot(sub(point, a), ab) / (dot(ab, ab) || 1)));
  return distance(point, add(a, scale(ab, t)));
}

/** Uniform Catmull-Rom spline through `points`, `perUnit` samples per unit of chord length. */
export function sampleCurve(points: readonly Vec3[], perUnit: number): Vec3[] {
  if (points.length < 2) return points.slice();
  const result: Vec3[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const steps = Math.max(2, Math.ceil(distance(p1, p2) * perUnit));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      result.push(catmullRom(p0, p1, p2, p3, t));
    }
  }
  result.push(points[points.length - 1]!);
  return result;
}

export function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const axis = (k: 0 | 1 | 2) =>
    0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  return [axis(0), axis(1), axis(2)];
}

function sampleRadius(radii: readonly number[], t: number): number {
  if (radii.length === 1) return radii[0]!;
  const scaled = t * (radii.length - 1);
  const i = Math.min(radii.length - 2, Math.floor(scaled));
  const f = scaled - i;
  return radii[i]! * (1 - f) + radii[i + 1]! * f;
}

/** Deterministic hash of integer coordinates to [0, 1). */
export function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
