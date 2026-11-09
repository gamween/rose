import { Matrix4, Quaternion, Vector3 } from "three";
import {
  BODY_BONE,
  BODY_FORWARD,
  BODY_LATERAL,
  BODY_UP,
  BONE_COUNT,
  FRONT_LEGS,
  HEAD_BONE,
  HIND_LEGS,
  JAW_BONE,
  JAW_HINGE,
  JOINTS,
  PIVOT,
  ROOT_BONE,
  WINGS,
  type DragonAnchors,
  type DragonModel,
} from "@/lib/voxel/dragon";
import type { Vec3 } from "@/lib/voxel/grid";
import { lerp } from "@/lib/landing/timeline";

/** Share of the total neck pitch and yaw taken by each joint, from the neck base to the skull. */
const PITCH_SHARE = [0.08, 0.14, 0.2, 0.24, 0.2, 0.14];
const YAW_SHARE = [0.05, 0.1, 0.15, 0.2, 0.25, 0.25];
/**
 * Aim steps, as (joint counted back from the last one, share of the remaining correction): the
 * upper neck bends toward the target, then the last joint points the snout at it, twice, the
 * second time taking up what is left once the skull has moved.
 */
const AIM_STEPS: readonly (readonly [fromLast: number, share: number])[] = [
  [2, 0.2],
  [1, 0.35],
  [0, 1],
  [0, 1],
];
/** Total neck pitch asleep (head on the ground) and awake, in radians; positive lowers the head. */
const SLEEP_PITCH = 1.05;
const WAKE_PITCH = -0.1;
/** Extra pitch per joint once awake: the base rears up and the upper neck bows forward, an S-curve. */
const S_CURVE = [-0.2, -0.14, -0.04, 0.1, 0.16, 0.12];
/** Extra pitch per joint once standing: the neck leans over the raised chest, then arches up. */
const STAND_CURVE = [0.45, 0.3, 0.05, -0.2, -0.3, -0.2];
/** Yaw per joint once standing: the neck uncurls from the near flank to rise in line with the chest. */
const STAND_YAW = [-0.25, -0.2, -0.15, -0.1, -0.05, 0];
/** Total neck yaw asleep, in radians. */
const SLEEP_YAW = -0.22;
/** Rearing: the torso pitches up about the hind hips (radians) while the hips rise (voxels). */
const REAR = 0.95;
const STAND_LIFT = 5;
/** Once standing, each hind paw stands this far ahead of the point under its hip. */
const STANCE_AHEAD = 3;
/** The dragon turns toward the camera as it rears (radians about the vertical). */
const TURN = 0.7;
/** Front legs once rearing: the upper leg swings forward, up and out to its side, the lower one curls the claws. */
const FRONT_RAISE = 0.8;
const FRONT_SPLAY = 0.95;
const FRONT_CURL = 0.75;
/**
 * Folded wing, as directions in the torso axes (forward, up, out to the wing's side): the arm runs
 * back along the flank, the forearm comes forward and up so the wrist stands over the shoulder, and
 * the fingers lie back along the flank to the hip, fanned just enough to keep the membrane between.
 */
const FOLDED_ARM: Vec3 = [-0.85, 0.12, 0.45];
const FOLDED_FOREARM: Vec3 = [0.92, 0.28, 0.2];
const FOLDED_FINGERS: readonly Vec3[] = [
  [-0.9, 0.3, 0.25],
  [-0.94, 0.22, 0.27],
  [-0.96, 0.14, 0.27],
  [-0.96, 0.06, 0.25],
];
/** Share of the rear that the arms counter, so the spread wings stand high above the rearing body. */
const WING_RAISE = 0.85;

export type Pose = {
  /** Per neck joint, from the base: 0 lying down, 1 raised (`SequenceState.neck`). */
  neck: readonly number[];
  /** Time in seconds, for the slow idle sway that travels up the raised neck and along the wings. */
  time: number;
  /** 0 lying on all fours, 1 rearing on the hind legs. */
  stand: number;
  /** Total neck yaw once raised, in radians, positive turns the head away from the camera. */
  yaw: number;
  /** World point the snout turns toward, and how much (0 the neck's own pose, 1 straight at it). */
  aim: Vector3;
  aimWeight: number;
  /** Jaw opening, 0 closed to 1 wide open. */
  jaw: number;
  /** Wings, 0 raised to 1 folded on the flanks (slightly negative at the overshoot). */
  wingFold: number;
  /** Wing membranes, 0 furled to 1 fully spread (slightly above 1 at the overshoot). */
  wingSpread: number;
};

/** Rest-space point the standing dragon looks at: ahead of the chest, above the raised head. */
const GAZE: Vec3 = [-14 + BODY_FORWARD[0] * 90, 105, -20 + BODY_FORWARD[2] * 90];

const UP = new Vector3(0, 1, 0);
const FACING = new Vector3(0, 0, 1);
const LATERAL = new Vector3(...BODY_LATERAL);
const FORWARD = new Vector3(...BODY_FORWARD);
const BODY_UPWARD = new Vector3(...BODY_UP);

function vector(point: Vec3): Vector3 {
  return new Vector3(point[0], point[1], point[2]);
}

/** Rotations taking each bone of a spread wing to its folded direction. */
type WingRig = { arm: Quaternion; forearm: Quaternion; fingers: Quaternion[] };

/** A direction given in the torso axes, toward the flank `side`. */
function bodyDirection([forward, up, out]: Vec3, side: number): Vector3 {
  return FORWARD.clone().multiplyScalar(forward).addScaledVector(BODY_UPWARD, up).addScaledVector(LATERAL, out * side).normalize();
}

function turnBetween(from: Vec3, to: Vec3, direction: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(vector(to).sub(vector(from)).normalize(), direction);
}

type LegRig = { upper: number; lower: number; restHint: Vector3; restThigh: Vector3; restShin: Vector3; stance: Vector3 };

/**
 * Skeleton of the dragon. The torso rears up about the hind hips and turns toward the camera; the
 * neck is a chain of joints, each rotating about its own lateral axis (pitch) and the vertical
 * (yaw), with the head at its end and the jaw hinged under it, and the upper neck can turn the
 * snout toward a point in the world; the front legs swing up and out as it rears while the hind
 * legs stay planted (a two-bone inverse kinematics solve keeps the paws on the ground); each wing
 * folds onto the back, its forearm closing against the arm and its fingers furling the membrane.
 * `update` recomputes the matrix of every bone, which the vertex shader blends per voxel.
 */
export class DragonRig {
  readonly bones: Matrix4[] = Array.from({ length: BONE_COUNT }, () => new Matrix4());
  private readonly lateral: Vector3[];
  private readonly wings: WingRig[];
  private readonly hindLegs: LegRig[];
  private readonly scratch = new Matrix4();
  private readonly rotation = new Matrix4();
  private readonly toJoint = new Matrix4();
  private readonly fromJoint = new Matrix4();
  private readonly local = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly identity = new Quaternion();
  private readonly turn = new Quaternion();
  private readonly armTurn = new Quaternion();
  private readonly forearmTurn = new Quaternion();
  private readonly inverseBody = new Matrix4();
  private readonly skull: Vec3;
  private readonly mouth: Vec3;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();

  constructor(anchors: Pick<DragonAnchors, "head" | "mouth">) {
    this.skull = anchors.head;
    this.mouth = anchors.mouth;
    this.lateral = JOINTS.map((joint, i) => {
      const next = JOINTS[i + 1] ?? [joint[0] + 8, joint[1], joint[2]];
      const tangent = new Vector3(next[0] - joint[0], 0, next[2] - joint[2]).normalize();
      return new Vector3().crossVectors(UP, tangent).normalize();
    });
    this.wings = WINGS.map((spec) => ({
      arm: turnBetween(spec.shoulder, spec.elbow, bodyDirection(FOLDED_ARM, spec.side)),
      forearm: turnBetween(spec.elbow, spec.wrist, bodyDirection(FOLDED_FOREARM, spec.side)),
      fingers: spec.tips.map((tip, k) => turnBetween(spec.wrist, tip, bodyDirection(FOLDED_FINGERS[k]!, spec.side))),
    }));
    this.rotateAbout(PIVOT, LATERAL, -REAR);
    const reared = this.scratch.clone().premultiply(this.local.makeTranslation(0, STAND_LIFT, 0));
    this.hindLegs = HIND_LEGS.map((leg) => {
      const hip = vector(leg.hip);
      const raised = hip.clone().applyMatrix4(reared);
      const knee = vector(leg.knee);
      const foot = vector(leg.foot);
      const line = foot.clone().sub(hip).normalize();
      const offset = knee.clone().sub(hip);
      return {
        upper: hip.distanceTo(knee),
        lower: knee.distanceTo(foot),
        restHint: offset.sub(line.multiplyScalar(offset.dot(line))).normalize(),
        restThigh: knee.clone().sub(hip).normalize(),
        restShin: foot.clone().sub(knee).normalize(),
        stance: new Vector3(raised.x + BODY_FORWARD[0] * STANCE_AHEAD, leg.foot[1], raised.z + BODY_FORWARD[2] * STANCE_AHEAD),
      };
    });
  }

  update(pose: Pose): void {
    const bones = this.bones;
    const stand = pose.stand;
    const turn = TURN * stand;
    this.rotateAbout(PIVOT, UP, turn);
    bones[ROOT_BONE]!.copy(this.scratch);
    this.rotateAbout(PIVOT, LATERAL, -REAR * stand);
    this.scratch.premultiply(this.local.makeTranslation(0, STAND_LIFT * stand, 0));
    bones[BODY_BONE]!.multiplyMatrices(bones[ROOT_BONE]!, this.scratch);

    for (let i = 0; i < JOINTS.length; i += 1) {
      const raised = pose.neck[i] ?? 0;
      const sway = Math.sin(pose.time * 0.5 - i * 0.45) * 0.012 * raised;
      const pitch = lerp(SLEEP_PITCH * PITCH_SHARE[i]!, WAKE_PITCH * PITCH_SHARE[i]! + S_CURVE[i]!, raised) + STAND_CURVE[i]! * stand + sway;
      const yaw = lerp(SLEEP_YAW, pose.yaw, raised) * YAW_SHARE[i]! + STAND_YAW[i]! * stand;
      this.rotateAbout(JOINTS[i]!, this.lateral[i]!, pitch, UP, yaw);
      bones[BODY_BONE + i + 1]!.multiplyMatrices(bones[BODY_BONE + i]!, this.scratch);
    }
    if (pose.aimWeight > 0) this.aimHead(pose.aim, pose.aimWeight);
    this.rotateAbout(JAW_HINGE, FACING, -0.3 * pose.jaw);
    bones[JAW_BONE]!.multiplyMatrices(bones[HEAD_BONE]!, this.scratch);

    for (const leg of FRONT_LEGS) {
      this.rotateAbout(leg.hip, LATERAL, -FRONT_RAISE * stand, FORWARD, FRONT_SPLAY * leg.side * stand);
      bones[leg.upper]!.multiplyMatrices(bones[BODY_BONE]!, this.scratch);
      this.rotateAbout(leg.knee, LATERAL, FRONT_CURL * stand);
      bones[leg.lower]!.multiplyMatrices(bones[leg.upper]!, this.scratch);
    }
    HIND_LEGS.forEach((leg, i) => this.plantHindLeg(leg, this.hindLegs[i]!, stand, turn));
    this.inverseBody.copy(bones[BODY_BONE]!).invert();
    WINGS.forEach((spec, i) => this.poseWing(spec, this.wings[i]!, pose));
  }

  /** Where the dragon looks when it stands without breathing fire: ahead of it and a little up. */
  gaze(out: Vector3): Vector3 {
    return this.transform(GAZE, ROOT_BONE, out);
  }

  /** World position of a point attached to the given bone. */
  transform(point: Vec3, bone: number, out: Vector3): Vector3 {
    return out.set(point[0], point[1], point[2]).applyMatrix4(this.bones[bone]!);
  }

  /** Bounds of the posed model, skinned on the CPU the same way as in the vertex shader. */
  bounds(model: DragonModel, min: Vector3, max: Vector3): void {
    min.setScalar(Infinity);
    max.setScalar(-Infinity);
    const point = this.a;
    const posed = this.b;
    const part = this.c;
    for (let i = 0; i < model.count; i += 1) {
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

  /**
   * Turns the head toward `target` in world space, a share of the way at each of the last neck
   * joints (cyclic coordinate descent), so the upper neck bends along and the snout ends on it.
   */
  private aimHead(target: Vector3, weight: number): void {
    const bones = this.bones;
    for (const [fromLast, share] of AIM_STEPS) {
      const joint = JOINTS.length - 1 - fromLast;
      const pivot = this.transform(JOINTS[joint]!, BODY_BONE + joint, this.a);
      const skull = this.transform(this.skull, HEAD_BONE, this.b);
      const snout = this.transform(this.mouth, HEAD_BONE, this.c).sub(skull).normalize();
      const wanted = this.d.copy(target).sub(skull).normalize();
      this.turn.setFromUnitVectors(snout, wanted);
      this.quaternion.slerpQuaternions(this.identity, this.turn, share * weight);
      this.rotation.makeRotationFromQuaternion(this.quaternion);
      this.scratch.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(this.rotation).multiply(this.fromJoint.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      for (let bone = BODY_BONE + joint + 1; bone <= HEAD_BONE; bone += 1) bones[bone]!.premultiply(this.scratch);
    }
  }

  /**
   * The paw slides from where it lay to its stance under the raised hip, flat on the ground; the thigh
   * and shin follow from the hip (moved by the torso) to the paw, the knee bent forward.
   */
  private plantHindLeg(leg: (typeof HIND_LEGS)[number], rig: LegRig, stand: number, turn: number): void {
    const bones = this.bones;
    const hip = this.transform(leg.hip, BODY_BONE, this.a);
    const foot = this.b.set(...leg.foot).lerp(rig.stance, stand).applyMatrix4(bones[ROOT_BONE]!);
    const forward = this.c.set(BODY_FORWARD[0], 0.4, BODY_FORWARD[2]).normalize();
    const hint = this.d.copy(rig.restHint).lerp(forward, stand).applyAxisAngle(UP, turn);
    const reach = foot.clone().sub(hip);
    const span = Math.min(rig.upper + rig.lower - 1e-3, Math.max(Math.abs(rig.upper - rig.lower) + 1e-3, reach.length()));
    reach.normalize();
    const along = (rig.upper * rig.upper - rig.lower * rig.lower + span * span) / (2 * span);
    const height = Math.sqrt(Math.max(0, rig.upper * rig.upper - along * along));
    hint.addScaledVector(reach, -hint.dot(reach)).normalize();
    const knee = hip.clone().addScaledVector(reach, along).addScaledVector(hint, height);

    this.place(leg.hip, hip, rig.restThigh, knee.clone().sub(hip).normalize());
    bones[leg.thigh]!.copy(this.scratch);
    this.place(leg.knee, knee, rig.restShin, foot.clone().sub(knee).normalize());
    bones[leg.shin]!.copy(this.scratch);
    this.rotateAbout(leg.foot, UP, turn);
    this.scratch.premultiply(this.local.makeTranslation(foot.x - leg.foot[0], foot.y - leg.foot[1], foot.z - leg.foot[2]));
    bones[leg.paw]!.copy(this.scratch);
  }

  /**
   * The arm turns from its spread direction toward its folded one (raised on top of that while
   * the dragon rears, so the wings stay high); the forearm and the fingers turn from following
   * their parent rigidly toward their own folded directions, the fingers with the membrane spread.
   */
  private poseWing(spec: (typeof WINGS)[number], rig: WingRig, pose: Pose): void {
    const arm = this.armTurn.setFromAxisAngle(LATERAL, REAR * WING_RAISE * pose.stand).multiply(this.quaternion.slerpQuaternions(this.identity, rig.arm, pose.wingFold));
    this.turnAbout(spec.shoulder, this.c.set(...spec.shoulder), arm, spec.arm);
    const elbow = this.transform(spec.elbow, spec.arm, this.a).applyMatrix4(this.inverseBody);
    const forearm = this.forearmTurn.slerpQuaternions(arm, rig.forearm, pose.wingFold);
    this.turnAbout(spec.elbow, elbow, forearm, spec.forearm);
    const wrist = this.transform(spec.wrist, spec.forearm, this.b).applyMatrix4(this.inverseBody);
    spec.fingers.forEach((bone, k) => {
      const ripple = this.turn.setFromAxisAngle(LATERAL, Math.sin(pose.time * 1.4 + k * 0.9) * 0.025 * pose.wingSpread);
      this.quaternion.slerpQuaternions(forearm, rig.fingers[k]!, 1 - pose.wingSpread).premultiply(ripple);
      this.turnAbout(spec.wrist, wrist, this.quaternion, bone);
    });
  }

  /** Sets `bone` to the torso times the move taking rest point `from` to `to` (torso space), turned by `turn`. */
  private turnAbout(from: Vec3, to: Vector3, turn: Quaternion, bone: number): void {
    this.fromJoint.makeTranslation(-from[0], -from[1], -from[2]);
    this.scratch.makeRotationFromQuaternion(turn).multiply(this.fromJoint);
    this.scratch.premultiply(this.toJoint.makeTranslation(to.x, to.y, to.z));
    this.bones[bone]!.multiplyMatrices(this.bones[BODY_BONE]!, this.scratch);
  }

  /** Into `scratch`: the rigid move taking `from` (rest) to `to`, turning `restDirection` onto `direction`. */
  private place(from: Vec3, to: Vector3, restDirection: Vector3, direction: Vector3): void {
    this.quaternion.setFromUnitVectors(restDirection, direction);
    this.fromJoint.makeTranslation(-from[0], -from[1], -from[2]);
    this.scratch.makeRotationFromQuaternion(this.quaternion).multiply(this.fromJoint);
    this.scratch.premultiply(this.toJoint.makeTranslation(to.x, to.y, to.z));
  }

  /** Into `scratch`: rotation about `pivot`, `angleB` about `axisB`, then `angleA` about `axisA`. */
  private rotateAbout(pivot: Vec3, axisA: Vector3, angleA: number, axisB: Vector3 = UP, angleB = 0): void {
    this.toJoint.makeTranslation(pivot[0], pivot[1], pivot[2]);
    this.fromJoint.makeTranslation(-pivot[0], -pivot[1], -pivot[2]);
    this.rotation.makeRotationAxis(axisB, angleB);
    this.scratch.makeRotationAxis(axisA, angleA);
    this.rotation.multiply(this.scratch);
    this.scratch.multiplyMatrices(this.toJoint, this.rotation).multiply(this.fromJoint);
  }
}
