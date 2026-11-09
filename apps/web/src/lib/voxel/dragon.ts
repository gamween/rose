import { VoxelGrid, add, catmullRom, cross, distance, hash3, normalize, scale, segmentDistance, sub, type Vec3 } from "./grid";

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

/*
 * The model is authored in its sleeping pose, curled into a closed ball like a sleeping cat: the
 * torso lies with its back to the far side, the neck wraps around the chest and runs along the
 * front of the body to the head, which rests on the forepaws, and the tail wraps around the hips
 * and along the front to the snout. Legs are tucked under the body, wings folded over the back by
 * the rig (they are modelled spread).
 *
 * Every limb, spine and tail segment is a rigid capsule on its own bone and its own grid part,
 * including the full sphere at its far joint: a joint bends about that sphere's center, so the
 * body stays closed at any angle, and each part keeps the surface where it touches another, so
 * nothing opens when the dragon uncurls. Only the wing membranes blend between bones.
 */

/** Joints of the torso: the hips (where the tail starts), the middle of the back, the chest (where the neck starts). */
const HIPS: Vec3 = [30, 15, -4];
const WAIST: Vec3 = [2, 17, -8];
const CHEST: Vec3 = [-26, 18, -2];
const TORSO_RADII = [15, 18.5, 17.5];

/** Joints of the neck, from the chest to the base of the skull, and its radius at each. */
const NECK_JOINTS: readonly Vec3[] = [CHEST, [-38, 18, 2], [-47, 16, 9], [-50, 15, 18], [-45, 14, 24], [-35, 14, 25], [-25, 14.5, 23], [-15, 15.5, 21], [-7, 17, 19]];
const NECK_RADII = [13, 12, 11.2, 10.4, 9.7, 9.1, 8.5, 8, 7.5];

/** Joints of the tail, from the hips around the body to the tip by the snout, and its radius at each. */
const TAIL_JOINTS: readonly Vec3[] = [HIPS, [44, 11, 1], [45, 8.5, 12], [37, 7, 19], [28, 5.5, 25], [19, 4.5, 29], [9, 3.5, 31], [-2, 3, 30]];
const TAIL_RADII = [13, 10, 8, 6.4, 5.2, 4.2, 3.2, 1.6];

/**
 * The head is drawn in its own coordinates (snout toward +x, the base of the skull at
 * `HEAD_BASE`), scaled by `HEAD_SCALE` and turned `HEAD_YAW` toward the camera about the end of the
 * neck, where it rests on the forearms, snout toward the tail.
 */
const HEAD_BASE: Vec3 = [-58, 43, 44];
const HEAD_SCALE = 1.2;
const HEAD_YAW = (-30 * Math.PI) / 180;
function headPoint(x: number, y: number, z: number): Vec3 {
  const [px, py, pz] = [(x - HEAD_BASE[0]) * HEAD_SCALE, (y - HEAD_BASE[1]) * HEAD_SCALE, (z - HEAD_BASE[2]) * HEAD_SCALE];
  const end = NECK_JOINTS[NECK_JOINTS.length - 1]!;
  return [end[0] + px * Math.cos(HEAD_YAW) + pz * Math.sin(HEAD_YAW), end[1] + py, end[2] - px * Math.sin(HEAD_YAW) + pz * Math.cos(HEAD_YAW)];
}
const SKULL = headPoint(-52, 40, 48);
const MOUTH = headPoint(-31, 35.5, 48);
const NOSTRILS: readonly Vec3[] = [headPoint(-32, 41, 47), headPoint(-32, 41, 49)];
/** Lower row of the eyes; the eye voxels carry their height above it (0 to 1), so the lids open from the slit up. */
const EYE_ROW = headPoint(0, 41, 0)[1];
export const JAW_HINGE = headPoint(-48, 34, 48);
/** The jaw opens about the head's lateral axis. */
export const JAW_AXIS: Vec3 = [Math.sin(HEAD_YAW), 0, Math.cos(HEAD_YAW)];

/** Bones, in hierarchy order (a parent before its children). */
export const ROOT_BONE = 0;
export const PELVIS_BONE = 1;
export const CHEST_BONE = 2;
const NECK_FIRST = 3;
export const HEAD_BONE = NECK_FIRST + NECK_JOINTS.length - 1;
export const JAW_BONE = HEAD_BONE + 1;
const TAIL_FIRST = JAW_BONE + 1;
const LIMB_FIRST = TAIL_FIRST + TAIL_JOINTS.length - 1;

/** A spine bone: it turns about `from` and points at `to` in the rest pose; `chain` counts the bones from the hips. */
export type SpineBone = { bone: number; parent: number; from: Vec3; to: Vec3; chain: number };

/** The spine from the hips: the torso, the neck and the head forward, the tail backward (hierarchy order). */
export const SPINE: readonly SpineBone[] = [
  { bone: PELVIS_BONE, parent: ROOT_BONE, from: HIPS, to: WAIST, chain: 0 },
  { bone: CHEST_BONE, parent: PELVIS_BONE, from: WAIST, to: CHEST, chain: 1 },
  ...NECK_JOINTS.slice(0, -1).map((from, k) => ({ bone: NECK_FIRST + k, parent: k === 0 ? CHEST_BONE : NECK_FIRST + k - 1, from, to: NECK_JOINTS[k + 1]!, chain: 2 + k })),
  { bone: HEAD_BONE, parent: HEAD_BONE - 1, from: NECK_JOINTS[NECK_JOINTS.length - 1]!, to: MOUTH, chain: NECK_JOINTS.length + 1 },
  ...TAIL_JOINTS.slice(0, -1).map((from, k) => ({ bone: TAIL_FIRST + k, parent: k === 0 ? PELVIS_BONE : TAIL_FIRST + k - 1, from, to: TAIL_JOINTS[k + 1]!, chain: 1 + k })),
];
/** The bones the head turns with when it aims: the chest, the neck and the head itself. */
export const FORWARD_CHAIN: readonly number[] = SPINE.filter((spine) => spine.bone >= CHEST_BONE && spine.bone <= HEAD_BONE).map((spine) => spine.bone);

/** Axes of a torso segment at rest: toward the head, up, and toward the near flank (the camera side). */
export type BodyAxes = { forward: Vec3; up: Vec3; lateral: Vec3 };
function axes(from: Vec3, to: Vec3): BodyAxes {
  const forward = normalize(sub(to, from));
  const up = normalize(sub([0, 1, 0], scale(forward, forward[1])));
  return { forward, up, lateral: cross(up, forward) };
}
export const PELVIS_AXES = axes(HIPS, WAIST);
export const CHEST_AXES = axes(WAIST, CHEST);

/** A point given in torso axes (forward, up, toward the flank `side`) from `origin`. */
export function inAxes(frame: BodyAxes, origin: Vec3, [forward, up, out]: Vec3, side: number): Vec3 {
  return add(add(add(origin, scale(frame.forward, forward)), scale(frame.up, up)), scale(frame.lateral, out * side));
}

/**
 * A leg, modelled tucked under the sleeping body: its joints from the hip or shoulder down to the
 * tip of the middle toe, one bone per segment (the last bone carries the paw), and its radius at
 * each joint. `side` is +1 for the near flank, -1 for the far one.
 */
export type Leg = { side: 1 | -1; joints: readonly Vec3[]; radii: readonly number[]; bones: readonly number[] };

function leg(frame: BodyAxes, origin: Vec3, side: 1 | -1, steps: readonly (readonly [Vec3, number])[], radii: readonly number[], firstBone: number): Leg {
  const joints: Vec3[] = [origin];
  for (const [direction, length] of steps) joints.push(add(joints[joints.length - 1]!, scale(normalize(inAxes(frame, [0, 0, 0], direction, side)), length)));
  return { side, joints, radii, bones: steps.map((_, k) => firstBone + k) };
}

/** Front legs, on the chest: upper arm back and down, forearm forward along the ground under the neck, paw flat. */
export const FRONT_LEGS: readonly Leg[] = ([1, -1] as const).map((side, k) =>
  leg(
    CHEST_AXES,
    inAxes(CHEST_AXES, CHEST, [-6, -5, 11], side),
    side,
    [
      [[-0.3, -0.8, 0.35], 15],
      [[0.97, -0.1, 0.1], 16],
      [[1, -0.05, 0.02], 8],
    ],
    [7.5, 5.6, 4.2, 3.4],
    LIMB_FIRST + k * 3,
  ),
);

/** Hind legs, on the pelvis: a heavy thigh forward along the flank, shin folded back, hock and paw flat forward. */
export const HIND_LEGS: readonly Leg[] = ([1, -1] as const).map((side, k) =>
  leg(
    PELVIS_AXES,
    inAxes(PELVIS_AXES, HIPS, [6, -3, 11], side),
    side,
    [
      [[0.74, -0.37, 0.56], 21],
      [[-0.9, -0.22, 0.12], 17],
      [[0.95, -0.05, 0.08], 12],
      [[1, 0, 0.04], 8],
    ],
    [10, 6.8, 4.8, 4, 3.4],
    LIMB_FIRST + 6 + k * 4,
  ),
);

/**
 * A wing, modelled fully spread (the rig furls and folds it): the arm from the shoulder to the
 * elbow, the forearm to the wrist, the fingers fanning from the wrist, and the membrane between
 * them, down to its root on the back.
 */
export type Wing = {
  /** +1 for the near wing, -1 for the far one. */
  side: 1 | -1;
  shoulder: Vec3;
  elbow: Vec3;
  wrist: Vec3;
  /** Finger tips, from the leading edge to the trailing one. */
  tips: readonly Vec3[];
  /** Where the trailing edge of the membrane meets the back. */
  root: Vec3;
  arm: number;
  forearm: number;
  fingers: readonly number[];
};

function wing(side: 1 | -1, arm: number): Wing {
  const at = (origin: Vec3, offset: Vec3) => inAxes(CHEST_AXES, origin, offset, side);
  const shoulder = at(CHEST, [-8, 13, 8]);
  const elbow = at(shoulder, [-4.6, 20.7, 13.8]);
  const wrist = at(elbow, [6.9, 34.5, 12.7]);
  const tips: Vec3[] = [at(wrist, [4.6, 23, 33.4]), at(wrist, [-12.7, 2.3, 41.4]), at(wrist, [-28.8, -17.3, 35.7]), at(wrist, [-39.1, -35.7, 19.6])];
  const root = at(WAIST, [-2, 15, 7]);
  return { side, shoulder, elbow, wrist, tips, root, arm, forearm: arm + 1, fingers: tips.map((_, i) => arm + 2 + i) };
}

const WING_FIRST = LIMB_FIRST + 14;
export const WINGS: readonly Wing[] = [wing(1, WING_FIRST), wing(-1, WING_FIRST + 6)];
export const BONE_COUNT = WING_FIRST + 12;
/** The bones of the torso, whose voxels swell with the breath. */
const TORSO_BONES: readonly number[] = [PELVIS_BONE, CHEST_BONE];

export type DragonAnchors = {
  /** Center of the skull in the rest pose. */
  head: Vec3;
  /** Front of the mouth, where fire is emitted (head bone space). */
  mouth: Vec3;
  /** Nostrils, where smoke rises from (head bone space). */
  nostrils: readonly Vec3[];
  chest: Vec3;
  /** Glowing tip of the tail, and the bone it rides on. */
  tailTip: Vec3;
  tailTipBone: number;
  /** Points of the body for hover hit regions: the bone each rides on and its radius. */
  regions: readonly { point: Vec3; bone: number; radius: number }[];
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

function dragonGrid(): VoxelGrid {
  return new VoxelGrid({ min: [-112, -1, -112], max: [112, 112, 96] });
}

/** Points along the Catmull-Rom curve through `joints`, segment by segment, about one per voxel. */
function segmentSamples(joints: readonly Vec3[], k: number): Vec3[] {
  const p0 = joints[Math.max(0, k - 1)]!;
  const p1 = joints[k]!;
  const p2 = joints[k + 1]!;
  const p3 = joints[Math.min(joints.length - 1, k + 2)]!;
  const steps = Math.max(2, Math.ceil(distance(p1, p2) * 1.5));
  return Array.from({ length: steps + 1 }, (_, s) => catmullRom(p0, p1, p2, p3, s / steps));
}

/**
 * A chain of rigid capsules along the curve through `joints`: segment `k` is part and bone
 * `bones[k]`, a tube tapering from `radii[k]` to `radii[k + 1]` that ends in a full sphere. `extra`
 * stamps details on each segment (the grid's current part is that segment's).
 */
function stampChain(
  { grid, skins }: Builder,
  joints: readonly Vec3[],
  radii: readonly number[],
  bones: readonly number[],
  extra: (k: number, samples: readonly Vec3[], skin: number) => void,
): void {
  bones.forEach((bone, k) => {
    grid.part = bone;
    const skin = skins.rigid(bone);
    const samples = segmentSamples(joints, k);
    samples.forEach((point, s) => {
      const r = radii[k]! + (radii[k + 1]! - radii[k]!) * (s / (samples.length - 1));
      grid.ellipsoid(point, [r, r, r], M.scale, skin, false);
    });
    extra(k, samples, skin);
  });
}

/** A short spike from the top of a capsule. */
function spike(grid: VoxelGrid, base: Vec3, height: number, skin: number): void {
  grid.tube([base, add(base, [0.5, height, 0])], [1.1, 0.3], M.spine, () => skin, false);
}

/** Torso, belly plates, chest and back spines. */
function buildTorso(builder: Builder): void {
  const { grid, skins } = builder;
  stampChain(builder, [HIPS, WAIST, CHEST], TORSO_RADII, [PELVIS_BONE, CHEST_BONE], (k, samples, skin) => {
    const frame = k === 0 ? PELVIS_AXES : CHEST_AXES;
    samples.forEach((point, s) => {
      const t = s / (samples.length - 1);
      const r = TORSO_RADII[k]! + (TORSO_RADII[k + 1]! - TORSO_RADII[k]!) * t;
      if (s % 3 === 0) spike(grid, inAxes(frame, point, [0, r - 1, 0], 1), 2.2 + 1.4 * Math.sin(Math.PI * t), skin);
      if (s % 5 === 0) grid.ellipsoid(inAxes(frame, point, [0, -r + 4, 0], 1), [r * 0.55, 2.6, r * 0.55], M.belly, skin, true);
    });
  });
  grid.part = CHEST_BONE;
  const chest = skins.rigid(CHEST_BONE);
  grid.ellipsoid(inAxes(CHEST_AXES, CHEST, [-8, -6, 0], 1), [13, 11, 14], M.scale, chest, false);
  for (const side of [1, -1]) grid.ellipsoid(inAxes(CHEST_AXES, CHEST, [-7, 2, 10], side), [9, 10, 8], M.scale, chest, false);
}

/** Neck with its throat plates and spines, and the tail with its spines and glowing tip. */
function buildNeckAndTail(builder: Builder): void {
  const { grid, skins } = builder;
  const neckBones = NECK_JOINTS.slice(0, -1).map((_, k) => NECK_FIRST + k);
  stampChain(builder, NECK_JOINTS, NECK_RADII, neckBones, (k, samples, skin) => {
    const frame = axes(NECK_JOINTS[k]!, NECK_JOINTS[k + 1]!);
    samples.forEach((point, s) => {
      const r = NECK_RADII[k]! + (NECK_RADII[k + 1]! - NECK_RADII[k]!) * (s / (samples.length - 1));
      if (s % 4 === 0) spike(grid, inAxes(frame, point, [0, r - 0.8, 0], 1), 1.6 + 0.12 * r, skin);
      if (s % 3 === 0) grid.ellipsoid(inAxes(frame, point, [0, -r + 1.6, 0], 1), [r * 0.5, 1.8, r * 0.5], M.belly, skin, true);
    });
  });
  const tailBones = TAIL_JOINTS.slice(0, -1).map((_, k) => TAIL_FIRST + k);
  stampChain(builder, TAIL_JOINTS, TAIL_RADII, tailBones, (k, samples, skin) => {
    const frame = axes(TAIL_JOINTS[k]!, TAIL_JOINTS[k + 1]!);
    samples.forEach((point, s) => {
      const r = TAIL_RADII[k]! + (TAIL_RADII[k + 1]! - TAIL_RADII[k]!) * (s / (samples.length - 1));
      if (s % 4 === 0 && k < tailBones.length - 1) spike(grid, inAxes(frame, point, [0, r - 0.6, 0], 1), 0.8 + 0.25 * r, skin);
    });
  });
  const tip = TAIL_JOINTS[TAIL_JOINTS.length - 1]!;
  const before = TAIL_JOINTS[TAIL_JOINTS.length - 2]!;
  grid.part = tailBones[tailBones.length - 1]!;
  grid.tube([add(tip, scale(normalize(sub(before, tip)), 4)), tip, add(tip, scale(normalize(sub(tip, before)), 3.5))], [2, 1.7, 0.7], M.tailTip, () => skins.rigid(grid.part), true);
}

/** Head and jaw (the jaw first: where they meet, the jaw keeps its cells), drawn in head coordinates. */
function buildHead({ grid, skins }: Builder): void {
  const head = skins.rigid(HEAD_BONE);
  const jaw = skins.rigid(JAW_BONE);
  const h = headPoint;
  const k = HEAD_SCALE;
  const tube = (points: Vec3[], radii: number[], material: number, skin: number, overwrite = true) =>
    grid.tube(points, radii.map((r) => r * k), material, () => skin, overwrite);
  /** One cell of the head drawing, at the head's scale. */
  const cell = (point: Vec3, material: number, skin: number) => grid.ellipsoid(point, [0.62 * k, 0.62 * k, 0.62 * k], material, skin);
  const carve = ([cx, cy, cz]: Vec3, r: number) => {
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z += 1) {
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r * r) grid.clear(x, y, z);
      }
    }
  };
  grid.part = JAW_BONE;
  tube([h(-47, 33.5, 48), h(-38, 33.5, 48), h(-32, 33.5, 48)], [3.2, 2.8, 1.8], M.scale, jaw);
  for (const side of [1, -1]) tube([h(-50, 31, 48 + side * 2), h(-52, 27.5, 48 + side * 3)], [1.2, 0.3], M.horn, jaw);
  grid.part = HEAD_BONE;
  grid.ellipsoid(SKULL, [8 * k, 6.5 * k, 6 * k], M.scale, head);
  grid.ellipsoid(h(-56, 43.5, 48), [6 * k, 4 * k, 5 * k], M.scale, head);
  tube([h(-46, 39, 48), h(-38, 38.5, 48), h(-31, 37.5, 48)], [5.2, 4.4, 3.2], M.scale, head);
  for (let x = -46; x <= -31; x += 1) {
    const inside = 4 - Math.max(0, (x + 34) * 0.4);
    for (let z = 43; z <= 53; z += 1) {
      if (Math.abs(z - 48) > inside) continue;
      carve(h(x, 35, z), 0.75 * k);
      cell(h(x, 36, z), M.mouth, head);
      grid.part = JAW_BONE;
      cell(h(x, 34, z), M.mouth, jaw);
      grid.part = HEAD_BONE;
    }
  }
  for (let x = -44; x <= -34; x += 3) {
    cell(h(x, 35, 51), M.claw, head);
    cell(h(x, 35, 45), M.claw, head);
  }
  for (const nostril of NOSTRILS) cell(nostril, M.nostril, head);
  for (const side of [1, -1]) {
    const z = 48 + side * 6;
    for (let x = -53; x <= -49; x += 1) cell(h(x, 41, z), M.eye, head);
    for (let x = -52; x <= -50; x += 1) cell(h(x, 42, z), M.eye, head);
    for (let x = -54; x <= -48; x += 1) cell(h(x, 43, z + side), M.brow, head);
    cell(h(-54, 42, z + side), M.brow, head);
    cell(h(-48, 42, z + side), M.brow, head);
    tube([h(-57, 45, 48 + side * 4), h(-62, 50, 48 + side * 5.5), h(-68, 53.5, 48 + side * 6.5), h(-73, 55, 48 + side * 7)], [2.2, 1.7, 1.1, 0.4], M.horn, head);
    tube([h(-56, 38, 48 + side * 6), h(-62, 37, 48 + side * 8.5), h(-67, 36.5, 48 + side * 10)], [1.5, 1, 0.3], M.horn, head);
  }
  for (let i = 0; i < 3; i += 1) {
    const x = -54 - i * 3;
    tube([h(x, 46, 48), h(x - 1.5, 49.5 - i * 0.5, 48)], [1, 0.3], M.spine, head, false);
  }
}

/** Legs: capsules with a muscle bulge on the upper segment, and clawed toes on the paw. */
function buildLegs({ grid, skins }: Builder): void {
  for (const limb of [...FRONT_LEGS, ...HIND_LEGS]) {
    limb.bones.forEach((bone, k) => {
      grid.part = bone;
      const skin = skins.rigid(bone);
      const from = limb.joints[k]!;
      const to = limb.joints[k + 1]!;
      const last = k === limb.bones.length - 1;
      if (last) {
        const along = normalize(sub(to, from));
        const side = normalize(cross(along, [0, 1, 0]));
        grid.ellipsoid(add(from, scale(along, 2)), [limb.radii[k]! + 0.6, limb.radii[k]! * 0.7, limb.radii[k]! + 0.6], M.scale, skin, false);
        for (const toe of [-1, 0, 1]) {
          const root = add(from, scale(side, toe * limb.radii[k]! * 0.75));
          const end = add(add(root, scale(along, distance(from, to) * (toe === 0 ? 1 : 0.85))), scale(side, toe * 1.6));
          grid.tube([root, end], [1.8, 1.3], M.scale, () => skin, false);
          grid.tube([end, add(add(end, scale(along, 2.6)), [0, -1, 0])], [1.1, 0.4], M.claw, () => skin, false);
        }
        return;
      }
      grid.tube([from, to], [limb.radii[k]!, limb.radii[k + 1]!], M.scale, () => skin, false);
      if (k === 0) {
        const bulge = limb.radii[0]! * (limb.bones.length > 3 ? 1.25 : 1.05);
        grid.ellipsoid(add(from, scale(sub(to, from), 0.28)), [bulge, bulge, bulge], M.scale, skin, false);
      }
    });
  }
}

/** Both wings. */
function buildWings(builder: Builder): void {
  for (const spec of WINGS) buildWing(builder, spec);
}

/**
 * Skin of a membrane voxel: the bones of the wing (and the back it hangs from) weighted by their
 * inverse squared distance, so the membrane stretches smoothly between the fingers as they fan.
 */
function membraneSkin(skins: SkinTable, spec: Wing, cell: Vec3): number {
  const segments: [number, Vec3, Vec3][] = [
    [spec.arm, spec.shoulder, spec.elbow],
    [spec.forearm, spec.elbow, spec.wrist],
    ...spec.tips.map((tip, i): [number, Vec3, Vec3] => [spec.fingers[i]!, spec.wrist, tip]),
    [CHEST_BONE, spec.root, spec.shoulder],
  ];
  return skins.id(segments.map(([bone, a, b]) => [bone, 1 / (segmentDistance(cell, a, b) ** 2 + 2)] as const));
}

function buildWing({ grid, skins }: Builder, spec: Wing): void {
  const { shoulder, elbow, wrist, tips, root } = spec;
  grid.part = spec.arm;
  grid.tube([shoulder, elbow], [3.8, 3], M.wingBone, () => skins.rigid(spec.arm), false);
  grid.part = spec.forearm;
  grid.tube([elbow, wrist], [3, 2.1], M.wingBone, () => skins.rigid(spec.forearm), false);
  const claw = skins.rigid(spec.forearm);
  const thumb = inAxes(CHEST_AXES, wrist, [3.5, 5.5, 0], spec.side);
  grid.tube([wrist, thumb, inAxes(CHEST_AXES, thumb, [2.3, 2.8, -0.5], spec.side)], [1.5, 1, 0.4], M.claw, () => claw, false);
  tips.forEach((tip, i) => {
    grid.part = spec.fingers[i]!;
    grid.tube([wrist, tip], [1.6, 0.6], M.wingBone, () => skins.rigid(spec.fingers[i]!), false);
  });

  grid.part = 200 + (spec.side > 0 ? 0 : 1);
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

const BUILD_STEPS: readonly ((builder: Builder) => void)[] = [buildTorso, buildNeckAndTail, buildHead, buildLegs, buildWings];

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

function collect({ grid, skins }: Builder): DragonModel {
  const positions: number[] = [];
  const colors: number[] = [];
  const data: number[] = [];
  const skinBones: number[] = [];
  const skinWeights: number[] = [];
  const tailTip = TAIL_JOINTS[TAIL_JOINTS.length - 1]!;

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
      local = Math.min(1, Math.max(0, (y - EYE_ROW) / HEAD_SCALE));
    } else if (mat === M.mouth) {
      kind = KIND.mouth;
      local = 1 - Math.min(1, distance([x, y, z], MOUTH) / (12 * HEAD_SCALE));
    } else if (mat === M.tailTip) {
      kind = KIND.tail;
      local = 1 - Math.min(1, distance([x, y, z], tailTip) / 7);
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
      if (TORSO_BONES.includes(bone)) torso += weight;
    }
    positions.push(x, y, z);
    data.push(kind, torso, seed, local);
  });

  const regions = [
    ...SPINE.map((spine) => ({ point: spine.from, bone: spine.bone, radius: spine.bone <= CHEST_BONE ? 19 : spine.bone < TAIL_FIRST ? 11 : 7 })),
    ...WINGS.map((spec) => ({ point: spec.elbow, bone: spec.arm, radius: 14 })),
    { point: SKULL, bone: HEAD_BONE, radius: 13 },
  ];
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
      chest: scale(add(WAIST, CHEST), 0.5),
      tailTip,
      tailTipBone: TAIL_FIRST + TAIL_JOINTS.length - 2,
      regions,
    },
  };
}
