import { describe, expect, it } from "vitest";
import { BODY_BONE, BONE_COUNT, HEAD_BONE, JAW_BONE, KIND, ROOT_BONE, WINGS, buildDragon, buildDragonInSteps } from "./dragon";

describe("procedural voxel dragon", () => {
  const model = buildDragon();
  const kinds = new Map<number, number>();
  for (let i = 0; i < model.count; i += 1) {
    const kind = model.data[i * 4]!;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  /** Number of voxels following `bone` more than anything else. */
  const ledBy = (bone: number) => {
    let count = 0;
    for (let i = 0; i < model.count; i += 1) if (model.skinBones[i * 4] === bone && model.skinWeights[i * 4]! > 0.5) count += 1;
    return count;
  };

  it("builds the same model in steps, pausing between them", async () => {
    let pauses = 0;
    const stepped = await buildDragonInSteps(() => {
      pauses += 1;
      return Promise.resolve();
    });
    expect(pauses).toBe(5);
    expect(stepped.positions).toEqual(model.positions);
    expect(stepped.colors).toEqual(model.colors);
    expect(stepped.data).toEqual(model.data);
    expect(stepped.skinBones).toEqual(model.skinBones);
    expect(stepped.skinWeights).toEqual(model.skinWeights);
  });

  it("is deterministic and sized for instanced rendering", () => {
    expect(buildDragon().positions).toEqual(model.positions);
    expect(model.count).toBeGreaterThan(6000);
    expect(model.count).toBeLessThan(30000);
    expect(model.positions).toHaveLength(model.count * 3);
    expect(model.colors).toHaveLength(model.count * 3);
    expect(model.data).toHaveLength(model.count * 4);
    expect(model.skinBones).toHaveLength(model.count * 4);
    expect(model.skinWeights).toHaveLength(model.count * 4);
  });

  it("has slit eyes, a mouth, nostrils, a tail tip and wing membranes", () => {
    expect(kinds.get(KIND.eye)).toBeGreaterThanOrEqual(6);
    expect(kinds.get(KIND.mouth)).toBeGreaterThan(0);
    expect(kinds.get(KIND.nostril)).toBe(2);
    expect(kinds.get(KIND.tail)).toBeGreaterThan(0);
    expect(kinds.get(KIND.membrane)).toBeGreaterThan(2000);
  });

  it("skins every voxel to valid bones with weights summing to one", () => {
    for (let i = 0; i < model.count; i += 1) {
      let total = 0;
      for (let k = 0; k < 4; k += 1) {
        const bone = model.skinBones[i * 4 + k]!;
        expect(Number.isInteger(bone)).toBe(true);
        expect(bone).toBeGreaterThanOrEqual(0);
        expect(bone).toBeLessThan(BONE_COUNT);
        total += model.skinWeights[i * 4 + k]!;
      }
      expect(total).toBeCloseTo(1, 5);
    }
  });

  it("gives the head, jaw, torso, ground and both wings their own voxels", () => {
    expect(ledBy(HEAD_BONE)).toBeGreaterThan(400);
    expect(ledBy(JAW_BONE)).toBeGreaterThan(40);
    expect(ledBy(BODY_BONE)).toBeGreaterThan(1500);
    expect(ledBy(ROOT_BONE)).toBeGreaterThan(400);
    for (const wing of WINGS) {
      const wingVoxels = [wing.arm, wing.forearm, ...wing.fingers].reduce((sum, bone) => sum + ledBy(bone), 0);
      expect(wingVoxels).toBeGreaterThan(1000);
    }
  });

  it("marks how much each voxel follows the torso, so only the chest swells with the breath", () => {
    for (let i = 0; i < model.count; i += 1) {
      const torso = model.data[i * 4 + 1]!;
      expect(torso).toBeGreaterThanOrEqual(0);
      expect(torso).toBeLessThanOrEqual(1);
    }
  });

  it("models the wings spread, one on each flank, and places the mouth ahead of the skull", () => {
    const [near, far] = WINGS;
    expect(near!.side).toBe(1);
    expect(far!.side).toBe(-1);
    expect(near!.tips[0]![2]).toBeGreaterThan(near!.shoulder[2] + 20);
    expect(far!.tips[0]![2]).toBeLessThan(far!.shoulder[2] - 20);
    for (const wing of WINGS) expect(wing.tips[0]![1]).toBeGreaterThan(wing.shoulder[1] + 40);
    expect(model.anchors.mouth[0]).toBeGreaterThan(model.anchors.head[0]);
    expect(model.anchors.tailTip[2]).toBeGreaterThan(model.anchors.chest[2] + 60);
  });
});
