import { describe, expect, it } from "vitest";
import { KIND, buildDragon } from "./dragon";

describe("procedural voxel dragon", () => {
  const model = buildDragon();
  const kinds = new Map<number, number>();
  for (let i = 0; i < model.count; i += 1) {
    const kind = model.data[i * 4]!;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  it("is deterministic and sized for instanced rendering", () => {
    expect(buildDragon().positions).toEqual(model.positions);
    expect(model.count).toBeGreaterThan(4000);
    expect(model.count).toBeLessThan(15000);
    expect(model.positions).toHaveLength(model.count * 3);
    expect(model.colors).toHaveLength(model.count * 3);
    expect(model.data).toHaveLength(model.count * 4);
  });

  it("has glowing eyes, a mouth, a tail tip and wing membranes", () => {
    expect(kinds.get(KIND.eye)).toBeGreaterThanOrEqual(8);
    expect(kinds.get(KIND.mouth)).toBeGreaterThan(0);
    expect(kinds.get(KIND.tail)).toBeGreaterThan(0);
    expect(kinds.get(KIND.membrane)).toBeGreaterThan(500);
  });

  it("bends only the neck and head", () => {
    for (let i = 0; i < model.count; i += 1) {
      const weight = model.data[i * 4 + 1]!;
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
      if (weight > 0) expect(model.positions[i * 3 + 1]!).toBeGreaterThan(model.anchors.neckPivot[1] - 3);
    }
  });

  it("is symmetric left to right except for the tail", () => {
    const set = new Set<string>();
    for (let i = 0; i < model.count; i += 1) set.add(`${model.positions[i * 3]},${model.positions[i * 3 + 1]},${model.positions[i * 3 + 2]}`);
    let mirrored = 0;
    let total = 0;
    for (let i = 0; i < model.count; i += 1) {
      const y = model.positions[i * 3 + 1]!;
      if (y < 12) continue;
      total += 1;
      if (set.has(`${-model.positions[i * 3]!},${y},${model.positions[i * 3 + 2]}`)) mirrored += 1;
    }
    expect(mirrored / total).toBeGreaterThan(0.9);
  });
});
