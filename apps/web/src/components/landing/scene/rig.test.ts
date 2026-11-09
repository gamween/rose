import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { SPINE_LAG, sequenceAt } from "@/lib/landing/timeline";
import { FRONT_LEGS, HEAD_BONE, HIND_LEGS, SPINE, WINGS, buildDragon } from "@/lib/voxel/dragon";
import { DragonRig, bodyPose, type Pose } from "./rig";

const model = buildDragon();

function poseAt(progress: number, aim = new Vector3(), aimWeight = 0, time = 0): Pose {
  const state = sequenceAt(progress);
  const pose: Pose = { time, rise: [], stand: [], coil: [], thrust: [], awake: state.wake * (1 - state.sleep), fire: state.fire, heave: state.heave, aim, aimWeight, jaw: 0, wingFold: state.wingFold, wingSpread: state.wingSpread };
  bodyPose(pose, progress);
  return pose;
}

function bounds(rig: DragonRig): { min: Vector3; max: Vector3 } {
  const min = new Vector3();
  const max = new Vector3();
  rig.bounds(model, min, max);
  return { min, max };
}

/** Every joint of every chain: the posed point as the parent bone carries it, and as the child does. */
function joints(rig: DragonRig): [Vector3, Vector3][] {
  const pairs: [Vector3, Vector3][] = SPINE.filter((spine) => spine.parent !== 0).map((spine) => [rig.transform(spine.from, spine.parent, new Vector3()), rig.transform(spine.from, spine.bone, new Vector3())]);
  for (const leg of [...FRONT_LEGS, ...HIND_LEGS]) {
    for (let k = 1; k < leg.bones.length; k += 1) pairs.push([rig.transform(leg.joints[k]!, leg.bones[k - 1]!, new Vector3()), rig.transform(leg.joints[k]!, leg.bones[k]!, new Vector3())]);
  }
  for (const wing of WINGS) {
    pairs.push([rig.transform(wing.elbow, wing.arm, new Vector3()), rig.transform(wing.elbow, wing.forearm, new Vector3())]);
    for (const finger of wing.fingers) pairs.push([rig.transform(wing.wrist, wing.forearm, new Vector3()), rig.transform(wing.wrist, finger, new Vector3())]);
  }
  return pairs;
}

describe("dragon rig", () => {
  it("sleeps in its modelled ball: every bone at rest", () => {
    const rig = new DragonRig(model.anchors);
    rig.update(poseAt(0));
    for (const spine of SPINE) expect(rig.transform(spine.to, spine.bone, new Vector3()).distanceTo(new Vector3(...spine.to))).toBeLessThan(1e-6);
    const { min, max } = bounds(rig);
    expect(max.y).toBeLessThan(60);
    expect(min.y).toBeGreaterThan(-2);
  });

  it("keeps every joint closed, whatever the pose (each bone turns about the end of its parent)", () => {
    const rig = new DragonRig(model.anchors);
    for (const progress of [0, 0.22, 0.27, 0.32, 0.45, 0.5, 0.8, 0.86, 0.9]) {
      rig.update(poseAt(progress, new Vector3(-60, 220, 40), sequenceAt(progress).focus, progress * 10));
      for (const [fromParent, fromChild] of joints(rig)) expect(fromParent.distanceTo(fromChild)).toBeLessThan(1e-4);
    }
  });

  it("rears up from the ball to standing tall, the hind paws planted on the ground", () => {
    const rig = new DragonRig(model.anchors);
    rig.update(poseAt(0));
    const lying = bounds(rig);
    rig.update(poseAt(0.45));
    const standing = bounds(rig);
    expect(standing.max.y).toBeGreaterThan(lying.max.y * 2.5);
    expect(standing.min.y).toBeGreaterThan(-6);
    for (const leg of HIND_LEGS) {
      const paw = rig.transform(leg.joints[leg.joints.length - 2]!, leg.bones[leg.bones.length - 1]!, new Vector3());
      expect(Math.abs(paw.y - leg.joints[leg.joints.length - 2]![1])).toBeLessThan(1e-4);
    }
  });

  it("spreads both wings wide and high at its prime, and folds them low over the back asleep", () => {
    const rig = new DragonRig(model.anchors);
    rig.update(poseAt(0.45));
    const spread = WINGS.map((wing) => rig.transform(wing.tips[0]!, wing.fingers[0]!, new Vector3()));
    const shoulders = WINGS.map((wing) => rig.transform(wing.shoulder, wing.arm, new Vector3()));
    spread.forEach((tip, i) => expect(tip.y).toBeGreaterThan(shoulders[i]!.y + 40));
    expect(spread[0]!.distanceTo(spread[1]!)).toBeGreaterThan(110);
    rig.update(poseAt(0));
    for (const wing of WINGS) for (const [k, tip] of wing.tips.entries()) expect(rig.transform(tip, wing.fingers[k]!, new Vector3()).y).toBeLessThan(52);
  });

  it("moves the body as a wave: each bone samples the timeline a little later away from the hips", () => {
    const pose = poseAt(0.3);
    const head = SPINE.findIndex((spine) => spine.bone === HEAD_BONE);
    expect(pose.stand[head]).toBeLessThan(pose.stand[0]!);
    expect(pose.rise[head]).toBeCloseTo(sequenceAt(0.3 - SPINE[head]!.chain * SPINE_LAG).rise, 9);
    const rig = new DragonRig(model.anchors);
    const base = new Vector3();
    const later = new Vector3();
    rig.update(poseAt(0.6, new Vector3(), 0, 1));
    rig.transform(model.anchors.head, HEAD_BONE, base);
    rig.update(poseAt(0.6, new Vector3(), 0, 1.15));
    rig.transform(model.anchors.head, HEAD_BONE, later);
    expect(base.distanceTo(later)).toBeGreaterThan(0.5);
  });

  it("turns the whole upper body toward the aim, and points the snout at it", () => {
    const rig = new DragonRig(model.anchors);
    const target = new Vector3(-120, 260, 40);
    rig.update(poseAt(0.6, target, 0));
    const chestBefore = rig.transform(SPINE[1]!.to, SPINE[1]!.bone, new Vector3());
    rig.update(poseAt(0.6, target, 1));
    const chestAfter = rig.transform(SPINE[1]!.to, SPINE[1]!.bone, new Vector3());
    expect(chestBefore.distanceTo(chestAfter)).toBeGreaterThan(1);
    const skull = rig.transform(model.anchors.head, HEAD_BONE, new Vector3());
    const snout = rig.transform(model.anchors.mouth, HEAD_BONE, new Vector3()).sub(skull).normalize();
    expect(snout.angleTo(target.clone().sub(skull).normalize())).toBeLessThan(0.02);
  });

  it("curls back into the same ball at the end", () => {
    const rig = new DragonRig(model.anchors);
    rig.update(poseAt(0));
    const start = bounds(rig);
    rig.update(poseAt(1));
    const end = bounds(rig);
    expect(end.min.distanceTo(start.min)).toBeLessThan(1e-6);
    expect(end.max.distanceTo(start.max)).toBeLessThan(1e-6);
  });
});
