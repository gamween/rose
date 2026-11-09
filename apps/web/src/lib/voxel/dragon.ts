import { VoxelGrid, hash3, pointOnCurve, sampleCurve, type Vec3 } from "./grid";

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
  nostril: 13,
} as const;

/** Per-voxel shading kind read by the dragon shader (`data.x`). */
export const KIND = {
  plain: 0,
  eye: 1,
  mouth: 2,
  tail: 3,
  crack: 4,
  membrane: 5,
  nostril: 6,
} as const;

/**
 * Skeleton of the neck: `JOINTS[0]` is the neck base (bone 1 rotates about it), the last joint is
 * the base of the skull (the head is bone `HEAD_BONE`). Bone 0 is the rigid body, `JAW_BONE` is
 * the lower jaw, a child of the head. Every voxel carries a bone coordinate: `floor` is the bone,
 * `fract` blends toward the next one (linear blend skinning, so the neck bends without gaps).
 */
export const JOINTS: readonly Vec3[] = [
  [-16, 27, -16],
  [-32, 35, -4],
  [-46, 43, 10],
  [-56, 48, 24],
  [-60, 47, 36],
  [-58, 43, 44],
];
export const HEAD_BONE = JOINTS.length;
export const JAW_BONE = HEAD_BONE + 1;
/** The raised far wing, folded down when the dragon sleeps (rotates about the hip to shoulder axis). */
export const FAR_WING_BONE = JAW_BONE + 1;
export const BONE_COUNT = FAR_WING_BONE + 1;
export const JAW_HINGE: Vec3 = [-48, 34, 48];
export const FAR_WING_SHOULDER: Vec3 = [-12, 32, -30];
export const FAR_WING_HIP: Vec3 = [14, 20, -48];
const FAR_WING_ELBOW: Vec3 = [0, 56, -44];

export type DragonAnchors = {
  /** Center of the skull in the rest pose. */
  head: Vec3;
  /** Front of the mouth, where fire is emitted (head bone space). */
  mouth: Vec3;
  /** Nostrils, where smoke rises from (head bone space). */
  nostrils: readonly Vec3[];
  chest: Vec3;
  tailTip: Vec3;
  /** Points along the torso for hover hit regions, with their radius. */
  body: readonly { point: Vec3; radius: number }[];
  /** Points along the tail for hover hit regions, with their radius. */
  tail: readonly { point: Vec3; radius: number }[];
  /** Elbow of the far wing (far wing bone space), for hover hit regions. */
  farWingElbow: Vec3;
};

export type DragonModel = {
  count: number;
  /** xyz per voxel, in voxel units (world units at scale 1). */
  positions: Float32Array;
  /** Linear RGB per voxel. */
  colors: Float32Array;
  /** Per voxel: kind, bone coordinate (bone + blend fraction), random seed (0..1), kind-specific local value. */
  data: Float32Array;
  anchors: DragonAnchors;
};

const SRGB: Record<number, readonly [string, string]> = {
  [M.scale]: ["#3a0e15", "#5c1420"],
  [M.belly]: ["#4a3c35", "#6a5a4e"],
  [M.horn]: ["#4a3c35", "#7a6a5f"],
  [M.spine]: ["#140607", "#2a1c18"],
  [M.membrane]: ["#55121d", "#781a28"],
  [M.wingBone]: ["#1d1715", "#2f2622"],
  [M.claw]: ["#b5a596", "#d8c9b4"],
  [M.eye]: ["#ffcf7a", "#ffe9a8"],
  [M.mouth]: ["#1c080a", "#2a0a0f"],
  [M.tailTip]: ["#ff9a3d", "#ffcf7a"],
  [M.brow]: ["#0f0c0b", "#1c080a"],
  [M.crack]: ["#9b1f2e", "#d8333c"],
  [M.nostril]: ["#0f0c0b", "#1c080a"],
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

const NECK: readonly Vec3[] = [...JOINTS, [-52, 40, 48]];
const NECK_RADII = [9.5, 7.6, 6.6, 6, 5.6, 5.4, 5.2];
const neckBone = (t: number) => Math.min(HEAD_BONE - 1e-3, t * HEAD_BONE);

const TORSO: readonly Vec3[] = [
  [-18, 22, -18],
  [2, 19, -30],
  [22, 16, -42],
];
const TORSO_RADII = [13, 14.5, 12];

const TAIL: readonly Vec3[] = [
  [26, 13, -46],
  [48, 8, -38],
  [60, 4, -12],
  [54, 3, 18],
  [36, 3, 40],
  [12, 4, 50],
  [-10, 5, 52],
  [-22, 7, 48],
  [-18, 10, 42],
];
const TAIL_RADII = [7.5, 6.2, 5, 4.1, 3.3, 2.6, 2, 1.5, 1];
const TAIL_TIP: Vec3 = [-18, 10, 42];

const SKULL: Vec3 = [-52, 40, 48];
const MOUTH: Vec3 = [-31, 35.5, 48];
const NOSTRILS: readonly Vec3[] = [
  [-32, 41, 47],
  [-32, 41, 49],
];

function dragonGrid(): VoxelGrid {
  return new VoxelGrid({ min: [-84, -1, -80], max: [72, 84, 66] });
}

/** Torso and belly plates. */
function buildTorso(grid: VoxelGrid): void {
  grid.tube(TORSO, TORSO_RADII, M.scale);
  grid.ellipsoid([-12, 14, -20], [8, 9, 10], M.belly, 0, true);
  grid.ellipsoid([4, 11, -30], [8, 9, 11], M.belly, 0, true);
}

/** Neck with its throat plates and spines. */
function buildNeck(grid: VoxelGrid): void {
  grid.tube(NECK, NECK_RADII, M.scale, neckBone);
  const neckSamples = sampleCurve(NECK, 1);
  neckSamples.forEach((p, i) => {
    const t = i / (neckSamples.length - 1);
    if (t < 0.12 || t > 0.96) return;
    const next = neckSamples[Math.min(neckSamples.length - 1, i + 1)]!;
    const [tx, , tz] = [next[0] - p[0], 0, next[2] - p[2]];
    const len = Math.hypot(tx, tz) || 1;
    const lateral: Vec3 = [tz / len, 0, -tx / len];
    const radius = sampleRadius(NECK_RADII, t);
    const throat: Vec3 = [p[0] + lateral[0] * 0.3, p[1] - radius + 1.3, p[2] + lateral[2] * 0.3];
    grid.ellipsoid(throat, [3, 1.6, 3], M.belly, neckBone(t), true);
    if (i % 4 === 0) {
      const top: Vec3 = [p[0], p[1] + radius - 0.6, p[2]];
      const spike = 1.4 + 1.6 * Math.sin(Math.PI * t);
      grid.tube([top, [top[0] - lateral[2] * 0.2, top[1] + spike, top[2] + lateral[0] * 0.2]], [0.9, 0.3], M.spine, () => neckBone(t), false);
    }
  });
}

/** Head and legs. */
function buildLimbs(grid: VoxelGrid): void {
  buildHead(grid);
  buildLegs(grid);
}

/** The far wing, then the near wing. */
function buildWings(grid: VoxelGrid): void {
  buildWing(grid, "far");
  buildWing(grid, "near");
}

/** Tail, back and tail spines, and the glowing tail tip. */
function buildTailAndSpines(grid: VoxelGrid): void {
  grid.tube(TAIL, TAIL_RADII, M.scale);
  const torsoSamples = sampleCurve(TORSO, 1);
  torsoSamples.forEach((p, i) => {
    if (i % 3 !== 0) return;
    const t = i / (torsoSamples.length - 1);
    const radius = sampleRadius(TORSO_RADII, t);
    grid.tube([[p[0], p[1] + radius - 0.8, p[2]], [p[0] + 0.6, p[1] + radius + 2.6, p[2] - 0.6]], [1.1, 0.3], M.spine, () => 0, false);
  });
  const tailSamples = sampleCurve(TAIL, 1);
  tailSamples.forEach((p, i) => {
    if (i % 4 !== 0) return;
    const t = i / (tailSamples.length - 1);
    if (t > 0.86) return;
    const radius = sampleRadius(TAIL_RADII, t);
    grid.tube([[p[0], p[1] + radius - 0.6, p[2]], [p[0], p[1] + radius + 1.8 * (1 - t) + 0.5, p[2]]], [0.8, 0.3], M.spine, () => 0, false);
  });
  grid.tube(
    [
      [-22, 7, 48],
      TAIL_TIP,
      [-13, 12.5, 38],
    ],
    [1.7, 1.5, 0.8],
    M.tailTip,
    () => 0,
    true,
  );
}

const BUILD_STEPS: readonly ((grid: VoxelGrid) => void)[] = [buildTorso, buildNeck, buildLimbs, buildWings, buildTailAndSpines];

/** Builds the rose dragon: a hand-authored procedural voxel model (no third-party asset). */
export function buildDragon(): DragonModel {
  const grid = dragonGrid();
  for (const step of BUILD_STEPS) step(grid);
  return collect(grid);
}

/**
 * The same model as `buildDragon`, built in short steps with `pause` between them (the landing
 * yields to the browser there, so no single task blocks input while the page loads).
 */
export async function buildDragonInSteps(pause: () => Promise<void>): Promise<DragonModel> {
  const grid = dragonGrid();
  for (const step of BUILD_STEPS) {
    step(grid);
    await pause();
  }
  return collect(grid);
}

function buildHead(grid: VoxelGrid): void {
  const w = HEAD_BONE;
  grid.ellipsoid(SKULL, [8, 6.5, 6], M.scale, w);
  grid.ellipsoid([-56, 43.5, 48], [6, 4, 5], M.scale, w);
  grid.tube([[-46, 39, 48], [-38, 38.5, 48], [-31, 37.5, 48]], [5.2, 4.4, 3.2], M.scale, () => w);
  grid.tube([[-47, 33.5, 48], [-38, 33.5, 48], [-32, 33.5, 48]], [3.2, 2.8, 1.8], M.scale, () => JAW_BONE);
  for (let x = -46; x <= -31; x += 1) {
    const inside = 4 - Math.max(0, (x + 34) * 0.4);
    for (let z = 43; z <= 53; z += 1) {
      if (Math.abs(z - 48) > inside) continue;
      grid.set(x, 35, z, 0, w);
      grid.set(x, 36, z, M.mouth, w);
      grid.set(x, 34, z, M.mouth, JAW_BONE);
    }
  }
  for (let x = -44; x <= -34; x += 3) {
    grid.set(x, 35, 51, M.claw, w);
    grid.set(x, 35, 45, M.claw, w);
  }
  for (const [nx, ny, nz] of NOSTRILS) grid.set(nx, ny, nz, M.nostril, w);
  for (const side of [1, -1]) {
    const z = 48 + side * 6;
    for (let x = -53; x <= -49; x += 1) grid.set(x, 41, z, M.eye, w);
    for (let x = -52; x <= -50; x += 1) grid.set(x, 42, z, M.eye, w);
    for (let x = -54; x <= -48; x += 1) grid.set(x, 43, z + side, M.brow, w);
    grid.set(-54, 42, z + side, M.brow, w);
    grid.set(-48, 42, z + side, M.brow, w);
    grid.tube(
      [
        [-57, 45, 48 + side * 4],
        [-62, 50, 48 + side * 5.5],
        [-68, 53.5, 48 + side * 6.5],
        [-73, 55, 48 + side * 7],
      ],
      [2.2, 1.7, 1.1, 0.4],
      M.horn,
      () => w,
    );
    grid.tube(
      [
        [-56, 38, 48 + side * 6],
        [-62, 37, 48 + side * 8.5],
        [-67, 36.5, 48 + side * 10],
      ],
      [1.5, 1, 0.3],
      M.horn,
      () => w,
    );
    grid.tube([[-50, 31, 48 + side * 2], [-52, 27.5, 48 + side * 3]], [1.2, 0.3], M.horn, () => JAW_BONE);
  }
  for (let i = 0; i < 3; i += 1) {
    const x = -54 - i * 3;
    grid.tube([[x, 46, 48], [x - 1.5, 49.5 - i * 0.5, 48]], [1, 0.3], M.spine, () => w, false);
  }
}

function buildLegs(grid: VoxelGrid): void {
  const legs: { hip: Vec3; knee: Vec3; foot: Vec3; radii: number[] }[] = [
    { hip: [-14, 16, -6], knee: [-18, 8, 2], foot: [-16, 2, 8], radii: [5.5, 4, 3.4] },
    { hip: [-14, 15, -30], knee: [-20, 8, -30], foot: [-22, 2, -28], radii: [5, 3.8, 3] },
    { hip: [22, 14, -30], knee: [32, 8, -20], foot: [34, 2, -12], radii: [6.5, 4.6, 3.6] },
    { hip: [22, 13, -54], knee: [30, 7, -56], foot: [34, 2, -54], radii: [6, 4.2, 3.4] },
  ];
  for (const leg of legs) {
    grid.tube([leg.hip, leg.knee, leg.foot], leg.radii, M.scale);
    for (const toe of [-2, 0, 2]) {
      const forward = leg.foot[2] > leg.hip[2] ? 1 : 0.4;
      grid.tube(
        [
          [leg.foot[0] + toe * 0.7, 1, leg.foot[2] + 1],
          [leg.foot[0] + toe * 1.3 + 1.5, 0.3, leg.foot[2] + 4 * forward],
        ],
        [1.1, 0.5],
        M.claw,
      );
    }
  }
}

function buildWing(grid: VoxelGrid, which: "far" | "near"): void {
  const far = which === "far";
  const bone = far ? FAR_WING_BONE : 0;
  const shoulder: Vec3 = far ? FAR_WING_SHOULDER : [-8, 31, -8];
  const elbow: Vec3 = far ? FAR_WING_ELBOW : [6, 46, -4];
  const wrist: Vec3 = far ? [18, 72, -56] : [28, 42, -8];
  const tips: Vec3[] = far
    ? [
        [48, 66, -66],
        [54, 48, -62],
        [44, 30, -56],
        [22, 22, -50],
      ]
    : [
        [54, 36, -16],
        [56, 26, -18],
        [46, 16, -20],
        [30, 14, -22],
      ];
  const hip: Vec3 = far ? FAR_WING_HIP : [12, 16, -26];
  grid.tube([shoulder, elbow, wrist], [3.2, 2.4, 1.8], M.wingBone, () => bone);
  grid.tube([wrist, [wrist[0] + 2, wrist[1] + 4, wrist[2] - 1], [wrist[0] + 3.5, wrist[1] + 6.5, wrist[2] - 2]], [1.3, 0.9, 0.4], M.claw, () => bone);
  tips.forEach((tip) => grid.tube([wrist, tip], [1.4, 0.5], M.wingBone, () => bone));

  const scallop = (u: number, v: number) => {
    const sum = u + v;
    if (sum <= 0) return true;
    return sum <= 1 - 0.22 * Math.sin((Math.PI * v) / sum);
  };
  const keepAll = () => true;
  for (let i = 0; i < tips.length - 1; i += 1) {
    grid.triangle(wrist, tips[i]!, tips[i + 1]!, M.membrane, scallop, false, bone);
  }
  grid.triangle(wrist, tips[tips.length - 1]!, elbow, M.membrane, keepAll, false, bone);
  grid.triangle(elbow, tips[tips.length - 1]!, hip, M.membrane, scallop, false, bone);
  grid.triangle(elbow, hip, shoulder, M.membrane, keepAll, false, bone);
}

function sampleRadius(radii: readonly number[], t: number): number {
  const scaled = t * (radii.length - 1);
  const i = Math.min(radii.length - 2, Math.floor(scaled));
  const f = scaled - i;
  return radii[i]! * (1 - f) + radii[i + 1]! * f;
}

function collect(grid: VoxelGrid): DragonModel {
  const positions: number[] = [];
  const colors: number[] = [];
  const data: number[] = [];

  grid.surface((x, y, z, material, bone) => {
    const seed = hash3(x, y, z);
    let mat = material;
    if ((mat === M.scale || mat === M.belly) && seed > 0.996 && y > 3) mat = M.crack;
    const pair = LINEAR[mat] ?? LINEAR[M.scale]!;
    const scalePattern = mat === M.scale && ((x + y + z) & 3) === 0 && ((x - y) & 1) === 0;
    const bellyPattern = mat === M.belly && y % 3 === 0;
    const mix = Math.min(1, Math.max(0, 0.55 + seed * 0.35 + (scalePattern || bellyPattern ? -0.5 : 0)));
    for (let k = 0; k < 3; k += 1) colors.push(pair[0][k]! * (1 - mix) + pair[1][k]! * mix);

    let kind: number = KIND.plain;
    let local = 0;
    if (mat === M.eye) {
      kind = KIND.eye;
      local = z > 48 ? 1 : 0;
    } else if (mat === M.mouth) {
      kind = KIND.mouth;
      local = 1 - Math.min(1, (MOUTH[0] - x) / 12);
    } else if (mat === M.tailTip) {
      kind = KIND.tail;
      local = 1 - Math.min(1, Math.hypot(x - TAIL_TIP[0], y - TAIL_TIP[1], z - TAIL_TIP[2]) / 7);
    } else if (mat === M.crack) {
      kind = KIND.crack;
    } else if (mat === M.membrane) {
      kind = KIND.membrane;
    } else if (mat === M.nostril) {
      kind = KIND.nostril;
    }
    positions.push(x, y, z);
    data.push(kind, bone, seed, local);
  });

  const tail = TAIL.map((point, i) => ({ point, radius: (TAIL_RADII[i] ?? 1) + 3 }));
  const body = TORSO.map((point, i) => ({ point, radius: (TORSO_RADII[i] ?? 10) + 3 }));
  return {
    count: positions.length / 3,
    positions: Float32Array.from(positions),
    colors: Float32Array.from(colors),
    data: Float32Array.from(data),
    anchors: {
      head: SKULL,
      mouth: MOUTH,
      nostrils: NOSTRILS,
      chest: pointOnCurve(TORSO, 0.3),
      tailTip: TAIL_TIP,
      body,
      tail,
      farWingElbow: FAR_WING_ELBOW,
    },
  };
}
