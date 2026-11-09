import { describe, expect, it } from "vitest";
import { BONE_COUNT, FAR_WING_BONE, HEAD_BONE, JAW_BONE, KIND, buildDragon, buildDragonInSteps } from "./dragon";

describe("procedural voxel dragon", () => {
  const model = buildDragon();
  const kinds = new Map<number, number>();
  for (let i = 0; i < model.count; i += 1) {
    const kind = model.data[i * 4]!;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

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
  });

  it("is deterministic and sized for instanced rendering", () => {
    expect(buildDragon().positions).toEqual(model.positions);
    expect(model.count).toBeGreaterThan(6000);
    expect(model.count).toBeLessThan(26000);
    expect(model.positions).toHaveLength(model.count * 3);
    expect(model.colors).toHaveLength(model.count * 3);
    expect(model.data).toHaveLength(model.count * 4);
  });

  it("has slit eyes, a mouth, nostrils, a tail tip and wing membranes", () => {
    expect(kinds.get(KIND.eye)).toBeGreaterThanOrEqual(6);
    expect(kinds.get(KIND.mouth)).toBeGreaterThan(0);
    expect(kinds.get(KIND.nostril)).toBe(2);
    expect(kinds.get(KIND.tail)).toBeGreaterThan(0);
    expect(kinds.get(KIND.membrane)).toBeGreaterThan(800);
  });

  it("skins every voxel to a valid bone and keeps the head, jaw and far wing on their bones", () => {
    let head = 0;
    let jaw = 0;
    let wing = 0;
    for (let i = 0; i < model.count; i += 1) {
      const bone = model.data[i * 4 + 1]!;
      expect(bone).toBeGreaterThanOrEqual(0);
      expect(bone).toBeLessThan(BONE_COUNT);
      if (bone === HEAD_BONE) head += 1;
      if (bone === JAW_BONE) jaw += 1;
      if (bone === FAR_WING_BONE) wing += 1;
      if (bone > 0 && bone < FAR_WING_BONE) expect(model.positions[i * 3]!).toBeLessThan(model.anchors.chest[0] + 6);
    }
    expect(head).toBeGreaterThan(400);
    expect(jaw).toBeGreaterThan(40);
    expect(wing).toBeGreaterThan(500);
  });

  it("places the mouth in front of the skull and the tail tip in the foreground", () => {
    expect(model.anchors.mouth[0]).toBeGreaterThan(model.anchors.head[0]);
    expect(model.anchors.tailTip[2]).toBeGreaterThan(model.anchors.chest[2] + 60);
  });
});
