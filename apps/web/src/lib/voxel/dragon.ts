import { VoxelGrid, add, cross, hash3, normalize, pointOnCurve, sampleCurve, scale, segmentDistance, sub, type Vec3 } from "./grid";

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
 * Skeleton. Bones come in hierarchy order (a parent before its children); every voxel is skinned
 * to up to four of them (linear blend skinning, so joints bend without gaps).
 *
 * - `ROOT_BONE` holds what stays on the ground (the tail) and turns the whole dragon.
 * - `BODY_BONE` is the torso: it rears up about `PIVOT`, between the hind hips.
 * - The neck: bone `BODY_BONE + i + 1` rotates about `JOINTS[i]`; the last one is the head
 *   (`HEAD_BONE`), and `JAW_BONE` is the lower jaw, hinged under it.
 * - Two bones per front leg, three per hind leg (thigh, shin and the paw that stays flat on the
 *   ground), and per wing an arm, a forearm and one bone per finger.
 */
export const ROOT_BONE = 0;
export const BODY_BONE = 1;
export const JOINTS: readonly Vec3[] = [
  [-16, 27, -16],
  [-32, 35, -4],
  [-46, 43, 10],
  [-56, 48, 24],
  [-60, 47, 36],
  [-58, 43, 44],
];
export const HEAD_BONE = BODY_BONE + JOINTS.length;
export const JAW_BONE = HEAD_BONE + 1;
export const JAW_HINGE: Vec3 = [-48, 34, 48];

const TORSO: readonly Vec3[] = [
  [-18, 22, -18],
  [2, 19, -30],
  [22, 16, -42],
];
const TORSO_RADII = [13, 14.5, 12];

/** Axes of the torso: toward the head, up, and toward the near flank (the camera side). */
export const BODY_FORWARD: Vec3 = normalize(sub(TORSO[0]!, TORSO[2]!));
export const BODY_UP: Vec3 = normalize(sub([0, 1, 0], scale(BODY_FORWARD, BODY_FORWARD[1])));
export const BODY_LATERAL: Vec3 = cross(BODY_UP, BODY_FORWARD);

/** A point given in the torso axes (forward, up, toward the flank `side`) from `origin`. */
function inBody(origin: Vec3, forward: number, up: number, out: number, side: 1 | -1): Vec3 {
  return add(add(add(origin, scale(BODY_FORWARD, forward)), scale(BODY_UP, up)), scale(BODY_LATERAL, out * side));
}

/** A front leg; `side` is +1 for the near flank, -1 for the far one. */
export type FrontLeg = { side: 1 | -1; hip: Vec3; knee: Vec3; foot: Vec3; radii: readonly number[]; upper: number; lower: number };
export type HindLeg = {
  hip: Vec3;
  knee: Vec3;
  foot: Vec3;
  radii: readonly number[];
  thigh: number;
  shin: number;
  paw: number;
};

export const FRONT_LEGS: readonly FrontLeg[] = [
  { side: 1, hip: [-14, 16, -6], knee: [-18, 8, 2], foot: [-16, 2, 8], radii: [5.5, 4, 3.4], upper: JAW_BONE + 1, lower: JAW_BONE + 2 },
  { side: -1, hip: [-14, 15, -30], knee: [-20, 8, -30], foot: [-22, 2, -28], radii: [5, 3.8, 3], upper: JAW_BONE + 3, lower: JAW_BONE + 4 },
];
const HIND_FIRST = JAW_BONE + 5;
export const HIND_LEGS: readonly HindLeg[] = [
  { hip: [22, 14, -30], knee: [32, 8, -20], foot: [34, 2, -12], radii: [6.5, 4.6, 3.6], thigh: HIND_FIRST, shin: HIND_FIRST + 1, paw: HIND_FIRST + 2 },
  { hip: [22, 13, -54], knee: [30, 7, -56], foot: [34, 2, -54], radii: [6, 4.2, 3.4], thigh: HIND_FIRST + 3, shin: HIND_FIRST + 4, paw: HIND_FIRST + 5 },
];

/** The torso rears up about the middle of the hind hips. */
export const PIVOT: Vec3 = scale(add(HIND_LEGS[0]!.hip, HIND_LEGS[1]!.hip), 0.5);

/**
 * A wing, modelled fully spread (the rig furls and folds it): the arm from the shoulder to the
 * elbow, the forearm to the wrist, the fingers fanning from the wrist, and the membrane between
 * them, down to its root on the flank.
 */
export type Wing = {
  /** +1 for the near wing, -1 for the far one. */
  side: 1 | -1;
  shoulder: Vec3;
  elbow: Vec3;
  wrist: Vec3;
  /** Finger tips, from the leading edge to the trailing one. */
  tips: readonly Vec3[];
  /** Where the trailing edge of the membrane meets the flank. */
  root: Vec3;
  arm: number;
  forearm: number;
  fingers: readonly number[];
};

function wing(side: 1 | -1, arm: number): Wing {
  const shoulder = inBody(pointOnCurve(TORSO, 0.22), 0, 10, 7, side);
  const elbow = inBody(shoulder, -4, 18, 12, side);
  const wrist = inBody(elbow, 6, 30, 11, side);
  const tips: Vec3[] = [inBody(wrist, 4, 20, 29, side), inBody(wrist, -11, 2, 36, side), inBody(wrist, -25, -15, 31, side), inBody(wrist, -34, -31, 17, side)];
  const root = inBody(pointOnCurve(TORSO, 0.86), 0, 6, 8, side);
  return { side, shoulder, elbow, wrist, tips, root, arm, forearm: arm + 1, fingers: tips.map((_, i) => arm + 2 + i) };
}

const WING_FIRST = HIND_FIRST + 6;
export const WINGS: readonly Wing[] = [wing(1, WING_FIRST), wing(-1, WING_FIRST + 6)];
export const BONE_COUNT = WING_FIRST + 12;

export type DragonAnchors = {
  /** Center of the skull in the rest pose. */
  head: Vec3;
  /** Front of the mouth, where fire is emitted (head bone space). */
  mouth: Vec3;
  /** Nostrils, where smoke rises from (head bone space). */
  nostrils: readonly Vec3[];
  chest: Vec3;
  /** Glowing tip of the tail (root bone space). */
  tailTip: Vec3;
  /** Points along the torso (body bone space) for hover hit regions, with their radius. */
  body: readonly { point: Vec3; radius: number }[];
  /** Points along the tail (root bone space) for hover hit regions, with their radius. */
  tail: readonly { point: Vec3; radius: number }[];
};

export type DragonModel = {
  count: number;
  /** xyz per voxel, in voxel units (world units at scale 1). */
  positions: Float32Array;
  /** Linear RGB per voxel. */
  colors: Float32Array;
  /**
   * Per voxel: kind, how much it follows the torso (where the breath swells the chest), random
   * seed (0..1), kind-specific local value (eye row, mouth depth, tail tip closeness).
   */
  data: Float32Array;
  /** Per voxel, the four bones it is skinned to and their weights (summing to 1). */
  skinBones: Float32Array;
  skinWeights: Float32Array;
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

/** Up to four (bone, weight) influences of a voxel. */
type Skin = readonly (readonly [bone: number, weight: number])[];

/** Weights are stored in steps of this size, so neighbouring voxels share their skin entry. */
const SKIN_STEP = 1 / 32;

/**
 * The distinct skins of the model. A grid cell stores the index of its skin as its weight, so the
 * build steps can stamp shapes skinned to several bones.
 */
class SkinTable {
  readonly skins: Skin[] = [];
  private readonly index = new Map<string, number>();

  rigid(bone: number): number {
    return this.id([[bone, 1]]);
  }

  /** Blends from bone `a` (t = 0) to bone `b` (t = 1). */
  blend(a: number, b: number, t: number): number {
    return this.id([
      [a, 1 - t],
      [b, t],
    ]);
  }

  id(influences: Skin): number {
    const strongest = influences
      .filter(([, weight]) => weight > 0)
      .sort((p, q) => q[1] - p[1])
      .slice(0, 4);
    const total = strongest.reduce((sum, [, weight]) => sum + weight, 0);
    const quantized = strongest
      .map(([bone, weight]): [number, number] => [bone, Math.round(weight / total / SKIN_STEP) * SKIN_STEP])
      .filter(([, weight]) => weight > 0);
    const sum = quantized.reduce((acc, [, weight]) => acc + weight, 0);
    const skin: Skin = quantized.map(([bone, weight]) => [bone, weight / sum] as const);
    const key = skin.map(([bone, weight]) => `${bone}:${weight.toFixed(4)}`).join(",");
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;
    this.skins.push(skin);
    this.index.set(key, this.skins.length - 1);
    return this.skins.length - 1;
  }
}

type Builder = { grid: VoxelGrid; skins: SkinTable };

const NECK: readonly Vec3[] = [...JOINTS, [-52, 40, 48]];
const NECK_RADII = [9.5, 7.6, 6.6, 6, 5.6, 5.4, 5.2];

/** Skin along the neck: each joint's bone blends into the next one, the last segment into the head. */
function neckSkin(skins: SkinTable, t: number): number {
  const coordinate = Math.min(JOINTS.length - 1e-3, t * JOINTS.length);
  const segment = Math.floor(coordinate);
  return skins.blend(BODY_BONE + segment, BODY_BONE + segment + 1, coordinate - segment);
}

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

/** The tail lies on the ground; only its root, under the hips, follows the torso. */
function tailSkin(skins: SkinTable, t: number): number {
  return skins.blend(BODY_BONE, ROOT_BONE, Math.min(1, t / 0.14));
}

const SKULL: Vec3 = [-52, 40, 48];
const MOUTH: Vec3 = [-31, 35.5, 48];
/** Lower row of the eyes; the eye voxels carry their row above it (0 or 1), so the lids open from the slit up. */
const EYE_ROW = 41;
const NOSTRILS: readonly Vec3[] = [
  [-32, 41, 47],
  [-32, 41, 49],
];

function dragonGrid(): VoxelGrid {
  return new VoxelGrid({ min: [-96, -1, -104], max: [96, 104, 76] });
}

/** Torso and belly plates. */
function buildTorso({ grid, skins }: Builder): void {
  const body = skins.rigid(BODY_BONE);
  grid.tube(TORSO, TORSO_RADII, M.scale, () => body);
  grid.ellipsoid([-12, 14, -20], [8, 9, 10], M.belly, body, true);
  grid.ellipsoid([4, 11, -30], [8, 9, 11], M.belly, body, true);
}

/** Neck with its throat plates and spines. */
function buildNeck({ grid, skins }: Builder): void {
  grid.tube(NECK, NECK_RADII, M.scale, (t) => neckSkin(skins, t));
  const neckSamples = sampleCurve(NECK, 1);
  neckSamples.forEach((p, i) => {
    const t = i / (neckSamples.length - 1);
    if (t < 0.12 || t > 0.96) return;
    const next = neckSamples[Math.min(neckSamples.length - 1, i + 1)]!;
    const [tx, , tz] = [next[0] - p[0], 0, next[2] - p[2]];
    const len = Math.hypot(tx, tz) || 1;
    const lateral: Vec3 = [tz / len, 0, -tx / len];
    const radius = sampleRadius(NECK_RADII, t);
    const skin = neckSkin(skins, t);
    const throat: Vec3 = [p[0] + lateral[0] * 0.3, p[1] - radius + 1.3, p[2] + lateral[2] * 0.3];
    grid.ellipsoid(throat, [3, 1.6, 3], M.belly, skin, true);
    if (i % 4 === 0) {
      const top: Vec3 = [p[0], p[1] + radius - 0.6, p[2]];
      const spike = 1.4 + 1.6 * Math.sin(Math.PI * t);
      grid.tube([top, [top[0] - lateral[2] * 0.2, top[1] + spike, top[2] + lateral[0] * 0.2]], [0.9, 0.3], M.spine, () => skin, false);
    }
  });
}

/** Head and legs. */
function buildLimbs(builder: Builder): void {
  buildHead(builder);
  buildLegs(builder);
}

/** Both wings. */
function buildWings(builder: Builder): void {
  for (const spec of WINGS) buildWing(builder, spec);
}

/** Tail, back and tail spines, and the glowing tail tip. */
function buildTailAndSpines({ grid, skins }: Builder): void {
  grid.tube(TAIL, TAIL_RADII, M.scale, (t) => tailSkin(skins, t));
  const body = skins.rigid(BODY_BONE);
  const root = skins.rigid(ROOT_BONE);
  const torsoSamples = sampleCurve(TORSO, 1);
  torsoSamples.forEach((p, i) => {
    if (i % 3 !== 0) return;
    const t = i / (torsoSamples.length - 1);
    const radius = sampleRadius(TORSO_RADII, t);
    grid.tube([[p[0], p[1] + radius - 0.8, p[2]], [p[0] + 0.6, p[1] + radius + 2.6, p[2] - 0.6]], [1.1, 0.3], M.spine, () => body, false);
  });
  const tailSamples = sampleCurve(TAIL, 1);
  tailSamples.forEach((p, i) => {
    if (i % 4 !== 0) return;
    const t = i / (tailSamples.length - 1);
    if (t > 0.86) return;
    const radius = sampleRadius(TAIL_RADII, t);
    const skin = tailSkin(skins, t);
    grid.tube([[p[0], p[1] + radius - 0.6, p[2]], [p[0], p[1] + radius + 1.8 * (1 - t) + 0.5, p[2]]], [0.8, 0.3], M.spine, () => skin, false);
  });
  grid.tube(
    [
      [-22, 7, 48],
      TAIL_TIP,
      [-13, 12.5, 38],
    ],
    [1.7, 1.5, 0.8],
    M.tailTip,
    () => root,
    true,
  );
}

const BUILD_STEPS: readonly ((builder: Builder) => void)[] = [buildTorso, buildNeck, buildLimbs, buildWings, buildTailAndSpines];

/** Builds the rose dragon: a hand-authored procedural voxel model (no third-party asset). */
export function buildDragon(): DragonModel {
  const builder: Builder = { grid: dragonGrid(), skins: new SkinTable() };
  for (const step of BUILD_STEPS) step(builder);
  return collect(builder);
}

/**
 * The same model as `buildDragon`, built in short steps with `pause` between them (the landing
 * yields to the browser there, so no single task blocks input while the page loads).
 */
export async function buildDragonInSteps(pause: () => Promise<void>): Promise<DragonModel> {
  const builder: Builder = { grid: dragonGrid(), skins: new SkinTable() };
  for (const step of BUILD_STEPS) {
    step(builder);
    await pause();
  }
  return collect(builder);
}

function buildHead({ grid, skins }: Builder): void {
  const w = skins.rigid(HEAD_BONE);
  const jaw = skins.rigid(JAW_BONE);
  grid.ellipsoid(SKULL, [8, 6.5, 6], M.scale, w);
  grid.ellipsoid([-56, 43.5, 48], [6, 4, 5], M.scale, w);
  grid.tube([[-46, 39, 48], [-38, 38.5, 48], [-31, 37.5, 48]], [5.2, 4.4, 3.2], M.scale, () => w);
  grid.tube([[-47, 33.5, 48], [-38, 33.5, 48], [-32, 33.5, 48]], [3.2, 2.8, 1.8], M.scale, () => jaw);
  for (let x = -46; x <= -31; x += 1) {
    const inside = 4 - Math.max(0, (x + 34) * 0.4);
    for (let z = 43; z <= 53; z += 1) {
      if (Math.abs(z - 48) > inside) continue;
      grid.set(x, 35, z, 0);
      grid.set(x, 36, z, M.mouth, w);
      grid.set(x, 34, z, M.mouth, jaw);
    }
  }
  for (let x = -44; x <= -34; x += 3) {
    grid.set(x, 35, 51, M.claw, w);
    grid.set(x, 35, 45, M.claw, w);
  }
  for (const [nx, ny, nz] of NOSTRILS) grid.set(nx, ny, nz, M.nostril, w);
  for (const side of [1, -1]) {
    const z = 48 + side * 6;
    for (let x = -53; x <= -49; x += 1) grid.set(x, EYE_ROW, z, M.eye, w);
    for (let x = -52; x <= -50; x += 1) grid.set(x, EYE_ROW + 1, z, M.eye, w);
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
    grid.tube([[-50, 31, 48 + side * 2], [-52, 27.5, 48 + side * 3]], [1.2, 0.3], M.horn, () => jaw);
  }
  for (let i = 0; i < 3; i += 1) {
    const x = -54 - i * 3;
    grid.tube([[x, 46, 48], [x - 1.5, 49.5 - i * 0.5, 48]], [1, 0.3], M.spine, () => w, false);
  }
}

function buildLegs({ grid, skins }: Builder): void {
  const toes = (foot: Vec3, forward: number, skin: number) => {
    for (const toe of [-2, 0, 2]) {
      grid.tube(
        [
          [foot[0] + toe * 0.7, foot[1] - 1, foot[2] + 1],
          [foot[0] + toe * 1.3 + 1.5, foot[1] - 1.7, foot[2] + 4 * forward],
        ],
        [1.1, 0.5],
        M.claw,
        () => skin,
      );
    }
  };
  for (const leg of FRONT_LEGS) {
    grid.tube([leg.hip, leg.knee, leg.foot], leg.radii, M.scale, (t) => skins.blend(leg.upper, leg.lower, smoothstep(0.38, 0.62, t)));
    toes(leg.foot, leg.foot[2] > leg.hip[2] ? 1 : 0.4, skins.rigid(leg.lower));
  }
  for (const leg of HIND_LEGS) {
    grid.tube([leg.hip, leg.knee, leg.foot], leg.radii, M.scale, (t) =>
      t < 0.75 ? skins.blend(leg.thigh, leg.shin, smoothstep(0.38, 0.62, t)) : skins.blend(leg.shin, leg.paw, smoothstep(0.8, 1, t)),
    );
    toes(leg.foot, leg.foot[2] > leg.hip[2] ? 1 : 0.4, skins.rigid(leg.paw));
  }
}

/**
 * Skin of a membrane voxel: the bones of the wing (and the flank it hangs from) weighted by their
 * inverse squared distance, so the membrane stretches smoothly between the fingers as they fan.
 */
function membraneSkin(skins: SkinTable, spec: Wing, cell: Vec3): number {
  const segments: [number, Vec3, Vec3][] = [
    [spec.arm, spec.shoulder, spec.elbow],
    [spec.forearm, spec.elbow, spec.wrist],
    ...spec.tips.map((tip, i): [number, Vec3, Vec3] => [spec.fingers[i]!, spec.wrist, tip]),
    [BODY_BONE, spec.root, spec.shoulder],
  ];
  return skins.id(segments.map(([bone, a, b]) => [bone, 1 / (segmentDistance(cell, a, b) ** 2 + 2)] as const));
}

function buildWing({ grid, skins }: Builder, spec: Wing): void {
  const { shoulder, elbow, wrist, tips, root } = spec;
  grid.tube([shoulder, elbow], [3.4, 2.6], M.wingBone, () => skins.rigid(spec.arm));
  grid.tube([elbow, wrist], [2.6, 1.8], M.wingBone, (t) => skins.blend(spec.arm, spec.forearm, smoothstep(0, 0.2, t)));
  const claw = skins.rigid(spec.forearm);
  const thumb = inBody(wrist, 3, 5, 0, spec.side);
  grid.tube([wrist, thumb, inBody(thumb, 2, 2.5, -0.5, spec.side)], [1.3, 0.9, 0.4], M.claw, () => claw);
  tips.forEach((tip, i) => grid.tube([wrist, tip], [1.4, 0.5], M.wingBone, () => skins.rigid(spec.fingers[i]!)));

  const scallop = (u: number, v: number) => {
    const sum = u + v;
    if (sum <= 0) return true;
    return sum <= 1 - 0.22 * Math.sin((Math.PI * v) / sum);
  };
  const keepAll = () => true;
  const skin = (cell: Vec3) => membraneSkin(skins, spec, cell);
  for (let i = 0; i < tips.length - 1; i += 1) {
    grid.triangle(wrist, tips[i]!, tips[i + 1]!, M.membrane, scallop, false, skin);
  }
  const last = tips[tips.length - 1]!;
  grid.triangle(wrist, last, elbow, M.membrane, keepAll, false, skin);
  grid.triangle(elbow, last, root, M.membrane, scallop, false, skin);
  grid.triangle(elbow, root, shoulder, M.membrane, keepAll, false, skin);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function sampleRadius(radii: readonly number[], t: number): number {
  const scaled = t * (radii.length - 1);
  const i = Math.min(radii.length - 2, Math.floor(scaled));
  const f = scaled - i;
  return radii[i]! * (1 - f) + radii[i + 1]! * f;
}

function collect({ grid, skins }: Builder): DragonModel {
  const positions: number[] = [];
  const colors: number[] = [];
  const data: number[] = [];
  const skinBones: number[] = [];
  const skinWeights: number[] = [];

  grid.surface((x, y, z, material, skinId) => {
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
      local = y - EYE_ROW;
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
    const skin = skins.skins[skinId] ?? [[ROOT_BONE, 1] as const];
    let torso = 0;
    for (let k = 0; k < 4; k += 1) {
      const [bone, weight] = skin[k] ?? [skin[0]![0], 0];
      skinBones.push(bone);
      skinWeights.push(weight);
      if (bone === BODY_BONE) torso = weight;
    }
    positions.push(x, y, z);
    data.push(kind, torso, seed, local);
  });

  const tail = TAIL.map((point, i) => ({ point, radius: (TAIL_RADII[i] ?? 1) + 3 }));
  const body = TORSO.map((point, i) => ({ point, radius: (TORSO_RADII[i] ?? 10) + 3 }));
  return {
    count: positions.length / 3,
    positions: Float32Array.from(positions),
    colors: Float32Array.from(colors),
    data: Float32Array.from(data),
    skinBones: Float32Array.from(skinBones),
    skinWeights: Float32Array.from(skinWeights),
    anchors: {
      head: SKULL,
      mouth: MOUTH,
      nostrils: NOSTRILS,
      chest: pointOnCurve(TORSO, 0.3),
      tailTip: TAIL_TIP,
      body,
      tail,
    },
  };
}
