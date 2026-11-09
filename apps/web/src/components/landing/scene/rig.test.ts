import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { sequenceAt } from "@/lib/landing/timeline";
import { HEAD_BONE, HIND_LEGS, WINGS, buildDragon } from "@/lib/voxel/dragon";
import { DragonRig, type Pose } from "./rig";

const model = buildDragon();

function poseAt(progress: number, aim = new Vector3(), aimWeight = 0): Pose {
  const state = sequenceAt(progress);
  return { neck: state.neck, time: 0, stand: state.stand, yaw: 0, aim, aimWeight, jaw: 0, wingFold: state.wingFold, wingSpread: state.wingSpread };
}

function bounds(rig: DragonRig): { min: Vector3; max: Vector3 } {
  const min = new Vector3();
  const max = new Vector3();
  rig.bounds(model, min, max);
  return { min, max };
}

describe("dragon rig", () => {
  it("rears up from lying to standing tall, the hind paws planted on the ground", () => {
    const rig = new DragonRig(model.anchors);
    rig.update(poseAt(0));
    const lying = bounds(rig);
    const pawsLying = HIND_LEGS.map((leg) => rig.transform(leg.foot, leg.paw, new Vector3()));
    rig.update(poseAt(0.45));
    const standing = bounds(rig);
    const pawsStanding = HIND_LEGS.map((leg) => rig.transform(leg.foot, leg.paw, new Vector3()));
    expect(standing.max.y).toBeGreaterThan(lying.max.y * 2);
    expect(standing.min.y).toBeGreaterThan(-3);
    pawsLying.forEach((paw, i) => {
      expect(paw.y).toBeCloseTo(HIND_LEGS[i]!.foot[1], 5);
      expect(pawsStanding[i]!.y).toBeCloseTo(HIND_LEGS[i]!.foot[1], 5);
    });
  });

  it("keeps the hind legs whole: the thigh and shin still meet at the knee", () => {
    const rig = new DragonRig(model.anchors);
    for (const progress of [0, 0.3, 0.35, 0.45, 0.8]) {
      rig.update(poseAt(progress));
      for (const leg of HIND_LEGS) {
        const fromThigh = rig.transform(leg.knee, leg.thigh, new Vector3());
        const fromShin = rig.transform(leg.knee, leg.shin, new Vector3());
        expect(fromThigh.distanceTo(fromShin)).toBeLessThan(1e-6);
        const ankle = rig.transform(leg.foot, leg.shin, new Vector3());
        expect(ankle.distanceTo(rig.transform(leg.foot, leg.paw, new Vector3()))).toBeLessThan(1e-6);
      }
    }
  });

  it("spreads both wings wide and high at its prime, and folds them low along the flanks asleep", () => {
    const rig = new DragonRig(model.anchors);
    rig.update(poseAt(0.45));
    const spread = WINGS.map((wing) => rig.transform(wing.tips[0]!, wing.fingers[0]!, new Vector3()));
    const shoulders = WINGS.map((wing) => rig.transform(wing.shoulder, wing.arm, new Vector3()));
    spread.forEach((tip, i) => expect(tip.y).toBeGreaterThan(shoulders[i]!.y + 40));
    expect(spread[0]!.distanceTo(spread[1]!)).toBeGreaterThan(100);
    rig.update(poseAt(0));
    const lying = bounds(rig);
    WINGS.forEach((wing) => {
      for (const [k, tip] of wing.tips.entries()) expect(rig.transform(tip, wing.fingers[k]!, new Vector3()).y).toBeLessThan(lying.max.y + 1);
    });
    expect(lying.max.y).toBeLessThan(60);
  });

  it("joins every bone of a wing at its joints, folded or spread", () => {
    const rig = new DragonRig(model.anchors);
    for (const progress of [0, 0.32, 0.45, 0.8]) {
      rig.update(poseAt(progress));
      for (const wing of WINGS) {
        expect(rig.transform(wing.elbow, wing.arm, new Vector3()).distanceTo(rig.transform(wing.elbow, wing.forearm, new Vector3()))).toBeLessThan(1e-6);
        for (const finger of wing.fingers) {
          expect(rig.transform(wing.wrist, wing.forearm, new Vector3()).distanceTo(rig.transform(wing.wrist, finger, new Vector3()))).toBeLessThan(1e-6);
        }
      }
    }
  });

  it("points the snout at the aim target", () => {
    const rig = new DragonRig(model.anchors);
    const target = new Vector3(-80, 260, 40);
    rig.update(poseAt(0.5, target, 1));
    const skull = rig.transform(model.anchors.head, HEAD_BONE, new Vector3());
    const snout = rig.transform(model.anchors.mouth, HEAD_BONE, new Vector3()).sub(skull).normalize();
    const wanted = target.clone().sub(skull).normalize();
    expect(snout.angleTo(wanted)).toBeLessThan(0.01);
  });
});
