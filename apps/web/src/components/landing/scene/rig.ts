import { Matrix4, Quaternion, Vector3 } from "three";
import {
  BONE_COUNT,
  CHEST_AXES,
  CHEST_BONE,
  FORWARD_CHAIN,
  FRONT_LEGS,
  HEAD_BONE,
  HIND_LEGS,
  JAW_AXIS,
  JAW_BONE,
  JAW_HINGE,
  PELVIS_AXES,
  PELVIS_BONE,
  ROOT_BONE,
  SPINE,
  WINGS,
  type BodyAxes,
  type DragonAnchors,
  type DragonModel,
  type Leg,
  type SpineBone,
} from "@/lib/voxel/dragon";
import type { Vec3 } from "@/lib/voxel/grid";
import { SPINE_LAG, bodyAt, lerp } from "@/lib/landing/timeline";

/*
 * Poses of the spine, as the direction of each bone in degrees above the horizontal, the dragon
 * facing -x: lying awake with the neck raised (sphinx), and rearing on its hind legs (stand). The
 * tail keeps its curl lying awake; standing, it runs back and down to the ground, then curves
 * along it toward the near side (pitch, then yaw from straight back).
 */
const SPHINX_TORSO = [3, 6];
const SPHINX_NECK = [24, 38, 54, 62, 52, 32, 10, -6];
const SPHINX_HEAD = -14;
const STAND_TORSO = [48, 60];
const STAND_NECK = [48, 64, 80, 92, 88, 66, 36, 10];
const STAND_HEAD = -6;
/**
 * Asleep at the end, as a dragon on its hoard: the torso lies as in the ball, the neck rises from
 * the chest in a high arch and comes back down, leaving an open loop above the forelegs, and the
 * head rests forward on the ground (pitch, then yaw from straight ahead toward the near side); the
 * tail stays wrapped along the ground in front of the body, its glowing tip in front of the chest.
 */
const REST_NECK: readonly (readonly [pitch: number, yaw: number])[] = [
  [62, 0],
  [52, 3],
  [36, 6],
  [12, 9],
  [-20, 12],
  [-52, 15],
  [-68, 18],
  [-50, 20],
];
const REST_HEAD: readonly [pitch: number, yaw: number] = [-6, 20];
/** Asleep at the end, the far wing stays half raised behind the back, its fingers and membrane showing. */
const REST_FAR_WING = { fold: 0.6, spread: 0.6 };
const STAND_TAIL: readonly (readonly [pitch: number, yaw: number])[] = [
  [-58, 0],
  [-34, 8],
  [-6, 25],
  [-2, 50],
  [-2, 80],
  [-2, 110],
  [-2, 140],
];
/** Rearing lifts the hips this high on the straightened hind legs, and turns the dragon this far toward the camera (radians). */
const STAND_LIFT = 13;
const TURN = 1.05;

/**
 * Bends added along the spine (radians, positive arches the bone back), indexed by distance from
 * the hips, as the dragon pushes forward into the jet (shoulders and neck reaching after the head).
 */
const THRUST_BEND = [-0.08, -0.12, -0.14, -0.08, -0.02, 0.04, 0.06, 0.04, 0, -0.04, -0.06];
/** How far each neck bone arches up halfway through uncurling or curling, so the head travels in an arc over the body. */
const NECK_ARC = 0.1;
/** How far each bone arches back per unit of rearing past full height (the follow-through). */
const OVERSHOOT_BEND = 1.2;
/** Travelling waves along the spine: the pulse of the jet, and the idle breathing. */
const PULSE = { amplitude: 0.045, speed: 7, step: 0.85 };
const IDLE = { amplitude: 0.014, speed: 0.9, step: 0.5 };
/** Side-to-side lash of the tail, from its base to its tip, stronger while the fire pours. */
const LASH = { amplitude: 0.05, speed: 2.1, step: 0.75 };

/** Aim steps along the forward chain (bone, share of what is left): the whole upper body turns toward the target, the head last. */
const AIM_STEPS: readonly (readonly [bone: number, share: number])[] = [
  [CHEST_BONE, 0.12],
  [FORWARD_CHAIN[1]!, 0.12],
  [FORWARD_CHAIN[4]!, 0.2],
  [FORWARD_CHAIN[6]!, 0.3],
  [FORWARD_CHAIN[8]!, 0.5],
  [HEAD_BONE, 1],
  [HEAD_BONE, 1],
];

/**
 * Front legs, as directions in the chest's axes (forward, up, out): lying awake the forearms reach
 * forward along the ground; rearing, the arms swing forward and out, claws curled.
 */
const FRONT_SPHINX: readonly Vec3[] = [
  [0.55, -0.62, 0.25],
  [0.97, -0.12, 0.05],
  [1, -0.08, 0],
];
const FRONT_STAND: readonly Vec3[] = [
  [0.55, -0.45, 0.6],
  [0.85, 0.35, 0.2],
  [0.45, -0.7, 0.1],
];
/** Standing hind legs: the paw stands ahead of and out from under the hip, the hock leans back from it by this share of its length, the knee bends forward. */
const HOCK_LEAN = 0.35;
const STANCE_AHEAD = 4;
const STANCE_OUT = 6;

/**
 * Folded wing, as directions in the chest's axes (forward, up, out to the wing's side): the arm
 * runs back along the back, the forearm comes forward so the wrist stands over the shoulder, and
 * the fingers lie back over the hips, fanned just enough to keep the membrane between them.
 */
const FOLDED_ARM: Vec3 = [-0.9, -0.12, 0.42];
const FOLDED_FOREARM: Vec3 = [0.95, 0.12, 0.22];
const FOLDED_FINGERS: readonly Vec3[] = [
  [-0.95, -0.1, 0.16],
  [-0.96, -0.15, 0.19],
  [-0.96, -0.2, 0.22],
  [-0.95, -0.26, 0.24],
];
/** How far the arms lift the spread wings against the chest's rearing pitch, so they stand high (radians). */
const WING_RAISE = 0.9;

export type Pose = {
  /** Time in seconds, for the waves that travel along the body and the wings. */
  time: number;
  /** Per spine bone (in `SPINE` order), its body channels, each sampled a little later further from the hips. */
  rise: number[];
  stand: number[];
  thrust: number[];
  /** Lying asleep at the end, stretched out (0 the pose of the other channels, 1 fully at rest). */
  rest: number[];
  /** Overall wakefulness, fire intensity and the deep breaths after it, for the waves. */
  awake: number;
  fire: number;
  heave: number;
  /** World point the snout turns toward, and how much (0 the body's own pose, 1 straight at it). */
  aim: Vector3;
  aimWeight: number;
  /** Jaw opening, 0 closed to 1 wide open. */
  jaw: number;
  /** Wings, 0 raised to 1 folded on the back (slightly negative at the overshoot). */
  wingFold: number;
  /** Wing membranes, 0 furled to 1 fully spread (slightly above 1 at the overshoot). */
  wingSpread: number;
};

/** The rearing travels up the body with this share of the lag, so the neck stays with the rising chest instead of being thrown back. */
const STAND_LAG = 0.6;

/**
 * Fills the body channels of `pose` for a point of the sequence: each spine bone samples the
 * timeline `SPINE_LAG` later per bone away from the hips, so every move travels along the body.
 */
export function bodyPose(pose: Pick<Pose, "rise" | "stand" | "thrust" | "rest">, progress: number): void {
  SPINE.forEach((spine, i) => {
    const body = bodyAt(progress - spine.chain * SPINE_LAG);
    pose.rise[i] = body.rise;
    pose.stand[i] = bodyAt(progress - spine.chain * SPINE_LAG * STAND_LAG).stand;
    pose.thrust[i] = body.thrust;
    pose.rest[i] = body.rest;
  });
}

const UP = new Vector3(0, 1, 0);
const JAW_TURN = new Vector3(...JAW_AXIS);
const IDENTITY = new Quaternion();

function vector(point: Vec3): Vector3 {
  return new Vector3(point[0], point[1], point[2]);
}

/** The rotation taking the frame (x, reference) to the frame of a direction and a second axis. */
function frame(direction: Vector3, reference: Vector3): Quaternion {
  const x = direction.clone().normalize();
  const y = reference.clone().addScaledVector(x, -reference.dot(x)).normalize();
  const z = new Vector3().crossVectors(x, y);
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/** The rotation taking a rest frame to a target frame. */
function turn(restDirection: Vector3, restReference: Vector3, direction: Vector3, reference: Vector3): Quaternion {
  return frame(direction, reference).multiply(frame(restDirection, restReference).invert());
}

/** A direction `degrees` above the horizontal toward -x (the way the dragon faces), and its back. */
function ahead(degrees: number): [Vector3, Vector3] {
  const a = (degrees * Math.PI) / 180;
  return [new Vector3(-Math.cos(a), Math.sin(a), 0), new Vector3(Math.sin(a), Math.cos(a), 0)];
}

/** A direction pitched `pitch` degrees from straight ahead (-x), turned `yaw` degrees toward the near side. */
function aheadTurned(pitch: number, yaw: number): [Vector3, Vector3] {
  const p = (pitch * Math.PI) / 180;
  const y = (yaw * Math.PI) / 180;
  return [new Vector3(-Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y)), UP.clone()];
}

/** A direction pitched `pitch` degrees from straight back (+x), turned `yaw` degrees toward the near side. */
function behind(pitch: number, yaw: number): [Vector3, Vector3] {
  const p = (pitch * Math.PI) / 180;
  const y = (yaw * Math.PI) / 180;
  return [new Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y)), UP.clone()];
}

/** A direction given in torso axes (forward, up, out to `side`). */
function inBody(axes: BodyAxes, [forward, up, out]: Vec3, side: number): Vector3 {
  return vector(axes.forward).multiplyScalar(forward).addScaledVector(vector(axes.up), up).addScaledVector(vector(axes.lateral), out * side).normalize();
}

type SpineRig = SpineBone & { direction: Vector3; lateral: Vector3; dorsal: Vector3; sphinx: Quaternion; stand: Quaternion; rest: Quaternion; index: number };
type SpinePose = "sphinx" | "stand" | "rest";
type WingRig = { arm: Quaternion; forearm: Quaternion; fingers: Quaternion[] };
type FrontRig = { sphinx: Quaternion[]; stand: Quaternion[] };
type HindRig = { stance: Vector3; lengths: number[] };

/**
 * Skeleton of the dragon. The spine (torso, neck, head and tail) is a chain of rigid bones, each
 * turned relative to its parent: its pose blends from curled asleep to lying awake to rearing,
 * with bends added for the thrust of the breath and waves that travel along it, and
 * the upper body turns toward the aim from the chest to the head. The front legs follow the chest,
 * the hind legs plant their paws on the ground under the raised hips (two-bone inverse kinematics
 * to the hock), and each wing folds onto the back, its forearm closing and its fingers furling the
 * membrane. `update` recomputes the matrix of every bone, which the vertex shader blends per voxel.
 */
export class DragonRig {
  readonly bones: Matrix4[] = Array.from({ length: BONE_COUNT }, () => new Matrix4());
  private readonly spine: SpineRig[];
  private readonly world: Quaternion[] = Array.from({ length: BONE_COUNT }, () => new Quaternion());
  private readonly wings: WingRig[];
  private readonly front: FrontRig[];
  /** The hind legs' stances depend on the raised pose, so the constructor fills them after posing without them. */
  private hind: HindRig[] = [];
  private readonly skull: Vec3;
  private readonly mouth: Vec3;
  private readonly gazePoint: Vec3;
  private readonly scratch = new Matrix4();
  private readonly rotation = new Matrix4();
  private readonly translate = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly blend = new Quaternion();
  private readonly extra = new Quaternion();
  private readonly armTurn = new Quaternion();
  private readonly forearmTurn = new Quaternion();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();

  constructor(anchors: Pick<DragonAnchors, "head" | "mouth">) {
    this.skull = anchors.head;
    this.mouth = anchors.mouth;
    const pivot = vector(SPINE[0]!.from);
    this.gazePoint = [pivot.x - 120, 135, pivot.z + 10];

    const targets = new Map<number, Record<SpinePose, Quaternion>>();
    this.spine = SPINE.map((spine, index) => {
      const direction = vector(spine.to).sub(vector(spine.from)).normalize();
      const dorsal = UP.clone().addScaledVector(direction, -UP.dot(direction)).normalize();
      const lateral = new Vector3().crossVectors(direction, dorsal).normalize();
      const neck = spine.bone - FORWARD_CHAIN[1]!;
      const tail = spine.bone > HEAD_BONE ? spine.chain - 1 : -1;
      const world = (pose: SpinePose): Quaternion => {
        const parent = targets.get(spine.parent)?.[pose] ?? IDENTITY;
        let target: [Vector3, Vector3] | null = null;
        if (pose === "rest") {
          if (spine.bone > CHEST_BONE && spine.bone < HEAD_BONE) target = aheadTurned(...REST_NECK[neck]!);
          else if (spine.bone === HEAD_BONE) target = aheadTurned(...REST_HEAD);
          else return IDENTITY.clone();
        } else if (spine.bone <= CHEST_BONE) target = ahead((pose === "sphinx" ? SPHINX_TORSO : STAND_TORSO)[spine.chain]!);
        else if (spine.bone < HEAD_BONE) target = ahead((pose === "sphinx" ? SPHINX_NECK : STAND_NECK)[neck]!);
        else if (spine.bone === HEAD_BONE) target = ahead(pose === "sphinx" ? SPHINX_HEAD : STAND_HEAD);
        else if (pose === "stand") target = behind(...STAND_TAIL[tail]!);
        return target ? turn(direction, dorsal, target[0], target[1]) : parent.clone();
      };
      const sphinx = world("sphinx");
      const stand = world("stand");
      const rest = world("rest");
      targets.set(spine.bone, { sphinx, stand, rest });
      const local = (pose: SpinePose, own: Quaternion) => (targets.get(spine.parent)?.[pose] ?? IDENTITY).clone().invert().multiply(own);
      return { ...spine, direction, lateral, dorsal, sphinx: local("sphinx", sphinx), stand: local("stand", stand), rest: local("rest", rest), index };
    });

    this.front = FRONT_LEGS.map((limb) => {
      const lateral = vector(CHEST_AXES.lateral).multiplyScalar(limb.side);
      const worlds = (directions: readonly Vec3[]) =>
        limb.bones.map((_, k) => turn(vector(limb.joints[k + 1]!).sub(vector(limb.joints[k]!)), lateral, inBody(CHEST_AXES, directions[k]!, limb.side), lateral));
      const locals = (directions: readonly Vec3[]) => worlds(directions).map((own, k, all) => (k === 0 ? own : all[k - 1]!.clone().invert().multiply(own)));
      return { sphinx: locals(FRONT_SPHINX), stand: locals(FRONT_STAND) };
    });

    this.wings = WINGS.map((spec) => ({
      arm: this.foldTurn(spec.shoulder, spec.elbow, FOLDED_ARM, spec.side),
      forearm: this.foldTurn(spec.elbow, spec.wrist, FOLDED_FOREARM, spec.side),
      fingers: spec.tips.map((tip, k) => this.foldTurn(spec.wrist, tip, FOLDED_FINGERS[k]!, spec.side)),
    }));
    this.update(this.restPose(1));
    const raised = this.bones[PELVIS_BONE]!;
    const root = this.bones[ROOT_BONE]!.clone().invert();
    this.hind = HIND_LEGS.map((limb) => {
      const hip = vector(limb.joints[0]!).applyMatrix4(raised).applyMatrix4(root);
      const forward = vector(PELVIS_AXES.forward).setY(0).normalize();
      const out = vector(PELVIS_AXES.lateral).setY(0).normalize().multiplyScalar(limb.side * STANCE_OUT);
      return {
        stance: new Vector3(hip.x + forward.x * STANCE_AHEAD + out.x, limb.joints[3]![1], hip.z + forward.z * STANCE_AHEAD + out.z),
        lengths: limb.bones.map((_, k) => vector(limb.joints[k + 1]!).distanceTo(vector(limb.joints[k]!))),
      };
    });

    this.update(this.restPose(0));
  }

  update(pose: Pose): void {
    const bones = this.bones;
    const stand = pose.stand[0] ?? 0;
    const hips = SPINE[0]!.from;
    this.rotateAbout(hips, UP, TURN * stand, bones[ROOT_BONE]!);
    this.world[ROOT_BONE]!.setFromAxisAngle(UP, TURN * stand);

    for (const spine of this.spine) {
      const i = spine.index;
      const standing = pose.stand[i] ?? 0;
      const local = this.blend
        .slerpQuaternions(IDENTITY, spine.sphinx, pose.rise[i] ?? 0)
        .slerp(spine.stand, Math.min(1, standing))
        .slerp(spine.rest, pose.rest[i] ?? 0);
      const chain = Math.min(spine.chain, THRUST_BEND.length - 1);
      const tail = spine.bone > HEAD_BONE;
      let bend = tail ? 0 : Math.max(0, standing - 1) * OVERSHOOT_BEND;
      if (spine.bone > CHEST_BONE && !tail) bend += NECK_ARC * Math.sin(Math.PI * Math.min(1, Math.max(0, pose.rise[i] ?? 0)));
      if (!tail) bend += THRUST_BEND[chain]! * (pose.thrust[i] ?? 0);
      bend += Math.sin(pose.time * PULSE.speed - spine.chain * PULSE.step) * PULSE.amplitude * pose.fire * (tail ? 0.3 : 1);
      bend += Math.sin(pose.time * IDLE.speed - spine.chain * IDLE.step) * IDLE.amplitude * (pose.awake + pose.heave * 2);
      local.multiply(this.extra.setFromAxisAngle(spine.lateral, bend));
      if (tail) {
        const lash = Math.sin(pose.time * LASH.speed - spine.chain * LASH.step) * LASH.amplitude * (0.3 * pose.awake + pose.fire + (pose.thrust[i] ?? 0) * 0.6 + pose.heave);
        local.multiply(this.extra.setFromAxisAngle(spine.dorsal, lash * Math.min(1, spine.chain / 2)));
      }
      const parent = bones[spine.parent]!;
      const at = this.a.set(...spine.from).applyMatrix4(parent);
      if (spine.parent === ROOT_BONE) at.y += STAND_LIFT * stand;
      this.world[spine.bone]!.multiplyQuaternions(this.world[spine.parent]!, local);
      this.place(spine.from, at, this.world[spine.bone]!, bones[spine.bone]!);
    }
    if (pose.aimWeight > 0) this.aimHead(pose.aim, pose.aimWeight);
    this.rotateAbout(JAW_HINGE, JAW_TURN, -0.3 * pose.jaw, this.scratch);
    bones[JAW_BONE]!.multiplyMatrices(bones[HEAD_BONE]!, this.scratch);

    const chestIndex = this.spine.findIndex((spine) => spine.bone === CHEST_BONE);
    FRONT_LEGS.forEach((limb, k) => this.poseFront(limb, this.front[k]!, pose.rise[chestIndex] ?? 0, pose.stand[chestIndex] ?? 0, pose.rest[chestIndex] ?? 0));
    this.hind.forEach((rig, k) => this.poseHind(HIND_LEGS[k]!, rig, Math.min(1, stand)));
    WINGS.forEach((spec, k) => this.poseWing(spec, this.wings[k]!, pose, Math.min(1, pose.stand[chestIndex] ?? 0)));
  }

  /** Where the dragon looks when it stands without breathing fire: ahead of it and a little up. */
  gaze(out: Vector3): Vector3 {
    return this.transform(this.gazePoint, ROOT_BONE, out);
  }

  /** World position of a point attached to the given bone. */
  transform(point: Vec3, bone: number, out: Vector3): Vector3 {
    return out.set(point[0], point[1], point[2]).applyMatrix4(this.bones[bone]!);
  }

  /** Bounds of the posed model, skinned on the CPU the same way as in the vertex shader (every `stride`-th voxel). */
  bounds(model: DragonModel, min: Vector3, max: Vector3, stride = 1): void {
    min.setScalar(Infinity);
    max.setScalar(-Infinity);
    const point = this.a;
    const posed = this.b;
    const part = this.c;
    for (let i = 0; i < model.count; i += stride) {
      point.fromArray(model.positions, i * 3);
      posed.set(0, 0, 0);
      for (let k = 0; k < 4; k += 1) {
        const weight = model.skinWeights[i * 4 + k]!;
        if (weight > 0) posed.addScaledVector(part.copy(point).applyMatrix4(this.bones[model.skinBones[i * 4 + k]!]!), weight);
      }
      min.min(posed);
      max.max(posed);
    }
  }

  /** A pose with every body channel at the same value (0 the sleeping ball, 1 standing), for the precomputations. */
  private restPose(stand: number): Pose {
    const channel = this.spine.map(() => stand);
    const none = this.spine.map(() => 0);
    return { time: 0, rise: channel, stand: channel, thrust: none, rest: none, awake: 0, fire: 0, heave: 0, aim: new Vector3(), aimWeight: 0, jaw: 0, wingFold: 1 - stand, wingSpread: stand };
  }

  /**
   * Turns the upper body toward `target` in world space, a share of the way at each step from the
   * chest up (cyclic coordinate descent), so the shoulders and neck follow and the snout ends on it.
   */
  private aimHead(target: Vector3, weight: number): void {
    const bones = this.bones;
    for (const [bone, share] of AIM_STEPS) {
      const spine = this.spine.find((candidate) => candidate.bone === bone)!;
      const pivot = this.transform(spine.from, bone, this.a);
      const skull = this.transform(this.skull, HEAD_BONE, this.b);
      const snout = this.transform(this.mouth, HEAD_BONE, this.c).sub(skull).normalize();
      const wanted = this.d.copy(target).sub(skull).normalize();
      this.extra.setFromUnitVectors(snout, wanted);
      this.quaternion.slerpQuaternions(IDENTITY, this.extra, share * weight);
      this.rotation.makeRotationFromQuaternion(this.quaternion);
      this.scratch.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(this.rotation).multiply(this.translate.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      for (const moved of FORWARD_CHAIN.slice(FORWARD_CHAIN.indexOf(bone))) {
        bones[moved]!.premultiply(this.scratch);
        this.world[moved]!.premultiply(this.quaternion);
      }
    }
  }

  /** Front leg: tucked under the chest, reaching forward lying awake, swung forward and out rearing, tucked again asleep. */
  private poseFront(limb: Leg, rig: FrontRig, rise: number, stand: number, rest: number): void {
    let parent = CHEST_BONE;
    limb.bones.forEach((bone, k) => {
      const local = this.blend.slerpQuaternions(IDENTITY, rig.sphinx[k]!, rise).slerp(rig.stand[k]!, Math.min(1, stand)).slerp(IDENTITY, rest);
      const at = this.a.set(...limb.joints[k]!).applyMatrix4(this.bones[parent]!);
      this.world[bone]!.multiplyQuaternions(this.world[parent]!, local);
      this.place(limb.joints[k]!, at, this.world[bone]!, this.bones[bone]!);
      parent = bone;
    });
  }

  /**
   * Hind leg: tucked, it follows the pelvis; standing, the paw stands flat under the raised hip, the
   * hock leans back above it and the thigh and shin reach from the hip to the hock, knee forward.
   */
  private poseHind(limb: Leg, rig: HindRig, stand: number): void {
    const bones = this.bones;
    const [upper, lower, hockLength] = rig.lengths as [number, number, number];
    const hip = this.transform(limb.joints[0]!, PELVIS_BONE, new Vector3());
    const ankle = rig.stance.clone().applyMatrix4(bones[ROOT_BONE]!);
    const forward = vector(PELVIS_AXES.forward).setY(0).normalize().applyQuaternion(this.world[ROOT_BONE]!);
    const hockAt = ankle.clone().addScaledVector(UP, hockLength * Math.sqrt(1 - HOCK_LEAN * HOCK_LEAN)).addScaledVector(forward, -hockLength * HOCK_LEAN);
    // When the hip rides higher (thrusting), the hock swings up toward it so the paw stays planted.
    if (hockAt.distanceTo(hip) > upper + lower - 0.5) hockAt.copy(ankle).addScaledVector(hip.clone().sub(ankle).normalize(), hockLength);
    const reach = hockAt.clone().sub(hip);
    const span = Math.min(upper + lower - 1e-3, Math.max(Math.abs(upper - lower) + 1e-3, reach.length()));
    reach.normalize();
    const along = (upper * upper - lower * lower + span * span) / (2 * span);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along));
    const hint = forward.clone().addScaledVector(UP, 0.3);
    hint.addScaledVector(reach, -hint.dot(reach)).normalize();
    const knee = hip.clone().addScaledVector(reach, along).addScaledVector(hint, height);
    const lateral = vector(PELVIS_AXES.lateral).multiplyScalar(limb.side).applyQuaternion(this.world[ROOT_BONE]!);
    const restLateral = vector(PELVIS_AXES.lateral).multiplyScalar(limb.side);
    const standing = [
      [hip, knee],
      [knee, hockAt],
      [hockAt, ankle],
      [ankle, ankle.clone().add(forward)],
    ] as const;
    let at = hip;
    limb.bones.forEach((bone, k) => {
      const rest = vector(limb.joints[k + 1]!).sub(vector(limb.joints[k]!));
      const [from, to] = standing[k]!;
      const target = turn(rest, restLateral, to.clone().sub(from), lateral);
      this.world[bone]!.slerpQuaternions(this.world[PELVIS_BONE]!, target, stand);
      this.place(limb.joints[k]!, at, this.world[bone]!, bones[bone]!);
      at = this.transform(limb.joints[k + 1]!, bone, new Vector3());
    });
  }

  /**
   * The arm turns from its spread direction toward its folded one (lifted on top of that while the
   * chest rears, so the wings stay high); the forearm and the fingers turn from following their
   * parent rigidly toward their own folded directions, the fingers with the membrane spread.
   */
  private poseWing(spec: (typeof WINGS)[number], rig: WingRig, pose: Pose, stand: number): void {
    const rest = spec.side < 0 ? (pose.rest[1] ?? 0) : 0;
    const fold = lerp(pose.wingFold - 0.08 * (pose.thrust[1] ?? 0), REST_FAR_WING.fold, rest);
    const spread = lerp(pose.wingSpread, REST_FAR_WING.spread, rest);
    const arm = this.armTurn
      .setFromAxisAngle(vector(CHEST_AXES.lateral), WING_RAISE * stand)
      .multiply(this.quaternion.slerpQuaternions(IDENTITY, rig.arm, fold));
    this.turnFromChest(spec.shoulder, vector(spec.shoulder), arm, spec.arm);
    const elbow = this.chestSpace(spec.elbow, spec.arm);
    const forearm = this.forearmTurn.slerpQuaternions(arm, rig.forearm, fold);
    this.turnFromChest(spec.elbow, elbow, forearm, spec.forearm);
    const wrist = this.chestSpace(spec.wrist, spec.forearm);
    spec.fingers.forEach((bone, k) => {
      const ripple = this.extra.setFromAxisAngle(vector(CHEST_AXES.lateral), Math.sin(pose.time * 1.4 + k * 0.9) * (0.025 + 0.04 * pose.fire) * spread);
      this.quaternion.slerpQuaternions(forearm, rig.fingers[k]!, 1 - spread).premultiply(ripple);
      this.turnFromChest(spec.wrist, wrist, this.quaternion, bone);
    });
  }

  /** A point of a wing bone, in the chest's rest space. */
  private chestSpace(point: Vec3, bone: number): Vector3 {
    return this.transform(point, bone, new Vector3()).applyMatrix4(this.scratch.copy(this.bones[CHEST_BONE]!).invert());
  }

  /** Sets `bone` to the chest times the move taking rest point `from` to `to` (chest rest space), turned by `rotation`. */
  private turnFromChest(from: Vec3, to: Vector3, rotation: Quaternion, bone: number): void {
    this.place(from, to, rotation, this.scratch);
    this.bones[bone]!.multiplyMatrices(this.bones[CHEST_BONE]!, this.scratch);
  }

  private foldTurn(from: Vec3, to: Vec3, folded: Vec3, side: number): Quaternion {
    return new Quaternion().setFromUnitVectors(vector(to).sub(vector(from)).normalize(), inBody(CHEST_AXES, folded, side));
  }

  /** Into `out`: the rigid move taking rest point `from` to `to`, turned by `rotation`. */
  private place(from: Vec3, to: Vector3, rotation: Quaternion, out: Matrix4): void {
    out.makeRotationFromQuaternion(rotation).multiply(this.translate.makeTranslation(-from[0], -from[1], -from[2]));
    out.premultiply(this.rotation.makeTranslation(to.x, to.y, to.z));
  }

  /** Into `out`: a rotation by `angle` about `axis` through `pivot`. */
  private rotateAbout(pivot: Vec3, axis: Vector3, angle: number, out: Matrix4): void {
    this.rotation.makeRotationAxis(axis, angle);
    out.makeTranslation(pivot[0], pivot[1], pivot[2]).multiply(this.rotation).multiply(this.translate.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
  }
}
