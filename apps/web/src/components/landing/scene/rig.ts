import { Matrix4, Vector3 } from "three";
import { BONE_COUNT, FAR_WING_BONE, FAR_WING_HIP, FAR_WING_SHOULDER, HEAD_BONE, JAW_BONE, JAW_HINGE, JOINTS } from "@/lib/voxel/dragon";
import type { Vec3 } from "@/lib/voxel/grid";

/** Share of the total neck pitch and yaw taken by each joint, from the neck base to the skull. */
const PITCH_SHARE = [0.08, 0.14, 0.2, 0.24, 0.2, 0.14];
const YAW_SHARE = [0.05, 0.1, 0.15, 0.2, 0.25, 0.25];
/** Share of the head lift taken by each joint: the upper neck throws the head back. */
const LIFT_SHARE = [0, 0, 0.1, 0.2, 0.3, 0.4];

export type Pose = {
  /** Total neck pitch in radians, positive lowers the head. */
  pitch: number;
  /** Total neck yaw in radians, positive turns the head away from the camera. */
  yaw: number;
  /** Total head lift in radians in the picture plane (about +z), positive turns the snout upward. */
  lift: number;
  /** Jaw opening, 0 closed to 1 wide open. */
  jaw: number;
  /** Far wing, 0 raised to 1 folded along the body. */
  wingFold: number;
};

const UP = new Vector3(0, 1, 0);
const FACING = new Vector3(0, 0, 1);
const JAW_AXIS = new Vector3(0, 0, 1);
const WING_AXIS = new Vector3(
  FAR_WING_SHOULDER[0] - FAR_WING_HIP[0],
  FAR_WING_SHOULDER[1] - FAR_WING_HIP[1],
  FAR_WING_SHOULDER[2] - FAR_WING_HIP[2],
).normalize();

/**
 * Neck skeleton of the dragon: a chain of joints along the neck, each rotating about its own
 * lateral axis (pitch) and the vertical axis (yaw), the head at the end and the jaw hinged under
 * it, plus the far wing. `update` recomputes the world matrix of every bone, which the vertex
 * shader blends per voxel.
 */
export class DragonRig {
  readonly bones: Matrix4[] = Array.from({ length: BONE_COUNT + 1 }, () => new Matrix4());
  private readonly lateral: Vector3[];
  private readonly scratch = new Matrix4();
  private readonly rotation = new Matrix4();
  private readonly toJoint = new Matrix4();
  private readonly fromJoint = new Matrix4();

  constructor() {
    this.lateral = JOINTS.map((joint, i) => {
      const next = JOINTS[i + 1] ?? [joint[0] + 8, joint[1], joint[2]];
      const tangent = new Vector3(next[0] - joint[0], 0, next[2] - joint[2]).normalize();
      return new Vector3().crossVectors(UP, tangent).normalize();
    });
  }

  update(pose: Pose): void {
    const bones = this.bones;
    bones[0]!.identity();
    for (let i = 0; i < JOINTS.length; i += 1) {
      const parent = bones[i]!;
      this.rotateAbout(JOINTS[i]!, this.lateral[i]!, pose.pitch * PITCH_SHARE[i]!, UP, pose.yaw * YAW_SHARE[i]!, pose.lift * LIFT_SHARE[i]!);
      bones[i + 1]!.multiplyMatrices(parent, this.scratch);
    }
    this.rotateAbout(JAW_HINGE, JAW_AXIS, -0.3 * pose.jaw, UP, 0);
    bones[JAW_BONE]!.multiplyMatrices(bones[HEAD_BONE]!, this.scratch);
    this.rotateAbout(FAR_WING_HIP, WING_AXIS, 1.15 * pose.wingFold, UP, 0);
    bones[FAR_WING_BONE]!.copy(this.scratch);
    bones[BONE_COUNT]!.copy(bones[FAR_WING_BONE]!);
  }

  /** World position of a point attached to the given bone. */
  transform(point: Vec3, bone: number, out: Vector3): Vector3 {
    return out.set(point[0], point[1], point[2]).applyMatrix4(this.bones[bone]!);
  }

  /** Rotation about `pivot`: `lift` about the facing axis, then `angleB` about `axisB`, then `angleA` about `axisA`. */
  private rotateAbout(pivot: Vec3, axisA: Vector3, angleA: number, axisB: Vector3, angleB: number, lift = 0): void {
    this.toJoint.makeTranslation(pivot[0], pivot[1], pivot[2]);
    this.fromJoint.makeTranslation(-pivot[0], -pivot[1], -pivot[2]);
    this.rotation.makeRotationAxis(FACING, lift);
    this.scratch.makeRotationAxis(axisB, angleB);
    this.rotation.multiply(this.scratch);
    this.scratch.makeRotationAxis(axisA, angleA);
    this.rotation.multiply(this.scratch);
    this.scratch.multiplyMatrices(this.toJoint, this.rotation).multiply(this.fromJoint);
  }
}
