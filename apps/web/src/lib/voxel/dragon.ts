import { VoxelGrid, hash3, pointOnCurve, type Vec3 } from "./grid";

/** Cell materials of the dragon model. */
export const M = {
  scale: 1,
  belly: 2,
  horn: 3,
  spine: 4,
  membrane: 5,
  wingBone: 6,
  claw: 7,
  eye: 8,
  mouth: 9,
  tailTip: 10,
  brow: 11,
  crack: 12,
} as const;

/** Per-voxel shading kind read by the dragon shader (`data.x`). */
export const KIND = {
  plain: 0,
  eye: 1,
  mouth: 2,
  tail: 3,
  crack: 4,
  membrane: 5,
} as const;

export type DragonAnchors = {
  /** Pivot of the neck bend (base of the neck). */
  neckPivot: Vec3;
  head: Vec3;
  /** Front of the mouth, where fire and smoke are emitted. */
  mouth: Vec3;
  eyes: readonly Vec3[];
  chest: Vec3;
  tailTip: Vec3;
};

export type DragonModel = {
  count: number;
  /** xyz per voxel, in voxel units. */
  positions: Float32Array;
  /** Linear RGB per voxel. */
  colors: Float32Array;
  /** Per voxel: kind, neck bend weight (0..1), random seed (0..1), kind-specific local value. */
  data: Float32Array;
  anchors: DragonAnchors;
};

const SRGB: Record<number, readonly [string, string]> = {
  [M.scale]: ["#3b2620", "#553229"],
  [M.belly]: ["#6e4430", "#85543a"],
  [M.horn]: ["#8f7c69", "#b3a08a"],
  [M.spine]: ["#1c1110", "#2b1814"],
  [M.membrane]: ["#4a1820", "#5e2028"],
  [M.wingBone]: ["#21130f", "#2e1a15"],
  [M.claw]: ["#b9a991", "#d6c8b2"],
  [M.eye]: ["#ffd27a", "#ffe6a8"],
  [M.mouth]: ["#3a1410", "#4a1a12"],
  [M.tailTip]: ["#ff8a34", "#ffc060"],
  [M.brow]: ["#170d0c", "#22130f"],
  [M.crack]: ["#7a2a14", "#a33a18"],
};

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexLinear(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [srgbToLinear((value >> 16) & 255), srgbToLinear((value >> 8) & 255), srgbToLinear(value & 255)];
}

const LINEAR: Record<number, readonly [[number, number, number], [number, number, number]]> = Object.fromEntries(
  Object.entries(SRGB).map(([key, [a, b]]) => [key, [hexLinear(a), hexLinear(b)]]),
);

const mirror = (p: Vec3): Vec3 => [-p[0], p[1], p[2]];

const NECK: Vec3[] = [
  [0, 22, 1],
  [0, 29, 0],
  [0, 35, -1],
  [0, 40, 1],
  [0, 43, 4],
];
const TAIL: Vec3[] = [
  [0, 9, -17],
  [9, 5, -21],
  [21, 3, -14],
  [26, 2, -1],
  [21, 2, 11],
  [10, 2, 17],
  [-2, 2, 18],
  [-10, 3, 14],
];
const TAIL_RADII = [5, 4.2, 3.4, 2.8, 2.2, 1.7, 1.2, 0.8];

const HEAD_CENTER: Vec3 = [0, 47, 6];
const MOUTH: Vec3 = [0, 43.5, 24];
const EYE_CENTERS: Vec3[] = [
  [4, 49, 12],
  [-4, 49, 12],
];

/** Builds the rose dragon: a hand-authored procedural voxel model (no third-party asset). */
export function buildDragon(): DragonModel {
  const grid = new VoxelGrid({ min: [-56, -2, -36], max: [56, 66, 30] });
  const neckWeight = (t: number) => t * t;

  grid.ellipsoid([0, 10, -13], [10, 8.5, 9], M.scale);
  grid.tube(
    [
      [0, 10, -14],
      [0, 15, -5],
      [0, 20, 1],
    ],
    [9, 9.5, 8.5],
    M.scale,
  );
  grid.ellipsoid([0, 17, 4], [6, 9, 4.5], M.belly, 0, true);
  grid.tube(NECK, [6, 5.2, 4.6, 4.2, 4], M.scale, neckWeight);
  for (let i = 0; i < 18; i += 1) {
    const t = 0.25 + (i / 17) * 0.75;
    const p = pointOnCurve(NECK, t);
    grid.ellipsoid([p[0], p[1] - 0.5, p[2] + 2.8], [2.6, 1.2, 1.4], M.belly, neckWeight(t), true);
  }

  buildHead(grid);

  grid.tube(TAIL, TAIL_RADII, M.scale);
  for (const side of [1, -1]) {
    const s = (p: Vec3): Vec3 => (side > 0 ? p : mirror(p));
    grid.ellipsoid(s([10, 8, -10]), [5, 7, 7.5], M.scale);
    grid.tube([s([11, 4, -6]), s([12, 1, 0])], [3.5, 2.6], M.scale);
    grid.tube([s([7, 16, 3]), s([8, 9, 6]), s([8, 2, 8])], [3.4, 2.8, 2.4], M.scale);
    for (const toe of [-1.6, 0, 1.6]) {
      grid.tube([s([8 + toe, 1, 9]), s([8 + toe * 1.2, 0, 12])], [1, 0.6], M.claw);
      grid.tube([s([12 + toe, 0, 1]), s([12 + toe * 1.2, 0, 4])], [0.9, 0.6], M.claw);
    }
    buildWing(grid, side);
  }

  for (let i = 0; i < 26; i += 1) {
    const t = i / 25;
    const p = pointOnCurve(NECK, t);
    const height = 1.6 + 1.6 * Math.sin(Math.PI * t);
    grid.tube([[0, p[1], p[2] - 3.4], [0, p[1] + height * 0.5, p[2] - 3.4 - height]], [0.9, 0.3], M.spine, () => neckWeight(t), false);
  }
  for (let i = 0; i < 9; i += 1) {
    const z = -2 - i * 2.4;
    const y = 23 - i * 0.9;
    grid.tube([[0, y, z], [0, y + 2.8, z - 1.4]], [1.1, 0.3], M.spine, () => 0, false);
  }
  for (let i = 0; i < 16; i += 1) {
    const t = i / 15;
    const p = pointOnCurve(TAIL, t * 0.85);
    const radius = TAIL_RADII[Math.min(TAIL_RADII.length - 1, Math.round(t * 0.85 * (TAIL_RADII.length - 1)))] ?? 1;
    grid.tube([[p[0], p[1] + radius - 0.5, p[2]], [p[0], p[1] + radius + 1.6 * (1 - t) + 0.6, p[2]]], [0.8, 0.3], M.spine, () => 0, false);
  }

  const tailTip = TAIL[TAIL.length - 1]!;
  grid.tube(
    [
      [-7, 3, 15.5],
      tailTip,
      [-12.5, 3.5, 12.5],
    ],
    [1.4, 1.2, 0.6],
    M.tailTip,
    () => 0,
    true,
  );

  return collect(grid, tailTip);
}

function buildHead(grid: VoxelGrid): void {
  const w = 1;
  grid.ellipsoid(HEAD_CENTER, [6.5, 6, 6.5], M.scale, w);
  grid.ellipsoid([0, 45.5, 14], [5.4, 4, 7], M.scale, w);
  grid.ellipsoid([0, 45, 20], [4.4, 3.2, 4], M.scale, w);
  grid.ellipsoid([0, 41.6, 15], [4.4, 1.8, 7.5], M.belly, w);
  for (let z = 14; z <= 23; z += 1) {
    for (let x = -4; x <= 4; x += 1) {
      grid.set(x, 43, z, M.mouth, w);
      if (Math.abs(x) <= 3 && z >= 16) grid.set(x, 44, z, M.mouth, w);
    }
  }
  for (const side of [1, -1]) {
    grid.set(side * 1, 47, 24, M.brow, w);
    grid.set(side * 2, 47, 24, M.brow, w);
    for (let z = 16; z <= 22; z += 2) grid.set(side * 5, 42, z, M.claw, w);
    const [ex, ey, ez] = EYE_CENTERS[side > 0 ? 0 : 1]!;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = 0; dy <= 1; dy += 1) {
        if (dy === 1 && dx * side < 0) continue;
        grid.set(ex + dx, ey + dy, ez, M.eye, w);
        grid.set(ex + dx, ey + dy, ez - 1, M.eye, w);
      }
    }
    for (let dx = -2; dx <= 2; dx += 1) grid.set(ex + dx, ey + 2, ez + 1, M.brow, w);
    grid.set(ex - side * 2, ey + 3, ez, M.brow, w);
    grid.tube(
      [
        [side * 3.5, 51, 4],
        [side * 5.5, 55, -1],
        [side * 7.5, 58, -7],
        [side * 7, 59, -11],
      ],
      [1.6, 1.2, 0.8, 0.4],
      M.horn,
      () => w,
    );
    grid.tube(
      [
        [side * 5, 47, 3],
        [side * 8, 47, -1],
        [side * 10, 48.5, -4],
      ],
      [1, 0.7, 0.3],
      M.horn,
      () => w,
    );
  }
}

function buildWing(grid: VoxelGrid, side: number): void {
  const s = (p: Vec3): Vec3 => [p[0] * side, p[1], p[2]];
  const shoulder = s([7, 24, -6]);
  const elbow = s([19, 37, -12]);
  const wrist = s([30, 46, -15]);
  const tips: Vec3[] = [s([50, 38, -19]), s([49, 22, -19]), s([40, 8, -17]), s([24, 3, -14])];
  grid.tube([shoulder, elbow, wrist], [2.6, 2, 1.6], M.wingBone);
  grid.tube([wrist, s([31, 50, -15]), s([33, 52, -16])], [1.2, 0.8, 0.4], M.claw);
  tips.forEach((tip) => grid.tube([wrist, tip], [1.2, 0.5], M.wingBone));

  const scallop = (u: number, v: number) => {
    const sum = u + v;
    if (sum <= 0) return true;
    return sum <= 1 - 0.2 * Math.sin((Math.PI * v) / sum);
  };
  for (let i = 0; i < tips.length - 1; i += 1) {
    grid.triangle(wrist, tips[i]!, tips[i + 1]!, M.membrane, scallop);
  }
  const hip = s([10, 9, -14]);
  grid.triangle(wrist, tips[tips.length - 1]!, elbow, M.membrane);
  grid.triangle(elbow, tips[tips.length - 1]!, hip, M.membrane, scallop);
  grid.triangle(elbow, hip, shoulder, M.membrane);
}

function collect(grid: VoxelGrid, tailTip: Vec3): DragonModel {
  const positions: number[] = [];
  const colors: number[] = [];
  const data: number[] = [];

  grid.surface((x, y, z, material, weight) => {
    const seed = hash3(x, y, z);
    let mat = material;
    if ((mat === M.scale || mat === M.belly) && seed > 0.982 && y > 3) mat = M.crack;
    const pair = LINEAR[mat] ?? LINEAR[M.scale]!;
    const pattern = mat === M.scale ? ((x + 2 * y + z) & 3) === 0 : mat === M.belly ? y % 3 === 0 : false;
    const mix = Math.min(1, Math.max(0, seed * 0.8 + (pattern ? -0.35 : 0.1)));
    for (let k = 0; k < 3; k += 1) colors.push(pair[0][k]! * (1 - mix) + pair[1][k]! * mix);

    let kind: number = KIND.plain;
    let local = 0;
    if (mat === M.eye) {
      kind = KIND.eye;
      const eye = x > 0 ? EYE_CENTERS[0]! : EYE_CENTERS[1]!;
      local = y - eye[1];
    } else if (mat === M.mouth) {
      kind = KIND.mouth;
      local = (z - 14) / 9;
    } else if (mat === M.tailTip) {
      kind = KIND.tail;
      local = 1 - Math.min(1, Math.hypot(x - tailTip[0], y - tailTip[1], z - tailTip[2]) / 6);
    } else if (mat === M.crack) {
      kind = KIND.crack;
    } else if (mat === M.membrane) {
      kind = KIND.membrane;
    }
    positions.push(x, y, z);
    data.push(kind, weight, seed, local);
  });

  return {
    count: positions.length / 3,
    positions: Float32Array.from(positions),
    colors: Float32Array.from(colors),
    data: Float32Array.from(data),
    anchors: {
      neckPivot: NECK[0]!,
      head: HEAD_CENTER,
      mouth: MOUTH,
      eyes: EYE_CENTERS,
      chest: [0, 16, 2],
      tailTip,
    },
  };
}
