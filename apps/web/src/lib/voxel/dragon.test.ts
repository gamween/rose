import { describe, expect, it } from "vitest";
import { BONE_COUNT, CHEST_BONE, FRONT_LEGS, HEAD_BONE, HIND_LEGS, JAW_BONE, KIND, PELVIS_BONE, SPINE, WINGS, buildDragon, buildDragonInSteps } from "./dragon";

/** Building the full model takes seconds on a loaded machine; the default 5 s timeout made the suite flaky. */
describe("procedural voxel dragon", { timeout: 30_000 }, () => {
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
  /** Extent of the voxels following `bone`, along each axis. */
  const extent = (bone: number) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < model.count; i += 1) {
      if (model.skinBones[i * 4] !== bone || model.skinWeights[i * 4]! < 0.5) continue;
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k]!, model.positions[i * 3 + k]!);
        max[k] = Math.max(max[k]!, model.positions[i * 3 + k]!);
      }
    }
    return max.map((value, k) => value - min[k]!);
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
    expect(model.count).toBeGreaterThan(20000);
    expect(model.count).toBeLessThan(50000);
    expect(model.positions).toHaveLength(model.count * 3);
    expect(model.colors).toHaveLength(model.count * 3);
    expect(model.data).toHaveLength(model.count * 4);
    expect(model.skinBones).toHaveLength(model.count * 4);
    expect(model.skinWeights).toHaveLength(model.count * 4);
  });

  it("has slit eyes, a mouth, nostrils, a tail tip and wing membranes", () => {
    expect(kinds.get(KIND.eye)).toBeGreaterThanOrEqual(6);
    expect(kinds.get(KIND.mouth)).toBeGreaterThan(0);
    expect(kinds.get(KIND.nostril)).toBeGreaterThanOrEqual(2);
    expect(kinds.get(KIND.tail)).toBeGreaterThan(0);
    expect(kinds.get(KIND.membrane)).toBeGreaterThan(2000);
  });

  it("skins every voxel to valid bones with weights summing to one", () => {
    const invalidBones: number[] = [];
    const badTotals: number[] = [];
    for (let i = 0; i < model.count; i += 1) {
      let total = 0;
      for (let k = 0; k < 4; k += 1) {
        const bone = model.skinBones[i * 4 + k]!;
        if (!Number.isInteger(bone) || bone < 0 || bone >= BONE_COUNT) invalidBones.push(i);
        total += model.skinWeights[i * 4 + k]!;
      }
      if (Math.abs(total - 1) >= 5e-6) badTotals.push(i);
    }
    expect(invalidBones).toEqual([]);
    expect(badTotals).toEqual([]);
  });

  it("gives every bone of the spine, the legs and the wings its own voxels", () => {
    for (const spine of SPINE) expect(ledBy(spine.bone)).toBeGreaterThan(100);
    expect(ledBy(JAW_BONE)).toBeGreaterThan(40);
    for (const leg of [...FRONT_LEGS, ...HIND_LEGS]) for (const bone of leg.bones) expect(ledBy(bone)).toBeGreaterThan(30);
    for (const wing of WINGS) {
      const wingVoxels = [wing.arm, wing.forearm, ...wing.fingers].reduce((sum, bone) => sum + ledBy(bone), 0);
      expect(wingVoxels).toBeGreaterThan(1000);
    }
  });

  it("has a heavy body: a deep torso, a thick neck tapering to the head and strong thighs", () => {
    const torso = Math.min(...extent(CHEST_BONE));
    expect(torso).toBeGreaterThan(30);
    const neckBase = SPINE.find((spine) => spine.parent === CHEST_BONE)!.bone;
    const neckTop = SPINE.find((spine) => spine.bone === HEAD_BONE)!.parent;
    const [, baseHeight] = extent(neckBase) as [number, number, number];
    const [, topHeight] = extent(neckTop) as [number, number, number];
    expect(baseHeight).toBeGreaterThan(topHeight);
    expect(baseHeight).toBeGreaterThan(20);
    for (const leg of HIND_LEGS) expect(Math.max(...extent(leg.bones[0]!))).toBeGreaterThan(20);
    expect(ledBy(PELVIS_BONE) + ledBy(CHEST_BONE)).toBeGreaterThan(5000);
  });

  it("marks how much each voxel follows the torso, so only the chest swells with the breath", () => {
    let torso = 0;
    const outOfRange: number[] = [];
    for (let i = 0; i < model.count; i += 1) {
      const weight = model.data[i * 4 + 1]!;
      if (weight < 0 || weight > 1) outOfRange.push(i);
      torso += weight;
    }
    expect(outOfRange).toEqual([]);
    expect(torso).toBeGreaterThan(5000);
  });

  it("models the wings spread, one on each flank, and places the mouth ahead of the skull", () => {
    const [near, far] = WINGS;
    expect(near!.side).toBe(1);
    expect(far!.side).toBe(-1);
    expect(near!.tips[0]![2]).toBeGreaterThan(near!.shoulder[2] + 20);
    expect(far!.tips[0]![2]).toBeLessThan(far!.shoulder[2] - 20);
    for (const wing of WINGS) expect(wing.tips[0]![1]).toBeGreaterThan(wing.shoulder[1] + 40);
    expect(model.anchors.mouth[0]).toBeGreaterThan(model.anchors.head[0]);
  });

  it("is authored curled into a ball: the long tail wraps in front of the head and around the end of the neck, the head lies in front of the body", () => {
    const tail = SPINE.filter((spine) => spine.bone > JAW_BONE);
    const length = tail.reduce((sum, spine) => sum + Math.hypot(spine.to[0] - spine.from[0], spine.to[1] - spine.from[1], spine.to[2] - spine.from[2]), 0);
    expect(length).toBeGreaterThan(200);
    expect(Math.max(...tail.map((spine) => spine.to[2]))).toBeGreaterThan(model.anchors.mouth[2] + 5);
    expect(model.anchors.tailTip[0]).toBeLessThan(model.anchors.chest[0] - 30);
    expect(model.anchors.head[2]).toBeGreaterThan(model.anchors.chest[2] + 15);
  });
});
