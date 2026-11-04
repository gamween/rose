import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROLLER_OPTIONS,
  QUALITY_TIERS,
  createQualityState,
  initialTierIndex,
  sampleFrame,
  type QualityState,
} from "./quality";

function feed(state: QualityState, frameMs: number, frames: number) {
  let current = state;
  let changes = 0;
  for (let i = 0; i < frames; i += 1) {
    const next = sampleFrame(current, frameMs);
    current = next.state;
    if (next.changed) changes += 1;
  }
  return { state: current, changes };
}

const window = DEFAULT_CONTROLLER_OPTIONS.windowFrames;

describe("adaptive quality controller", () => {
  it("orders tiers from best to cheapest", () => {
    for (let i = 1; i < QUALITY_TIERS.length; i += 1) {
      expect(QUALITY_TIERS[i]!.pixelRatio).toBeLessThan(QUALITY_TIERS[i - 1]!.pixelRatio);
      expect(QUALITY_TIERS[i]!.particles).toBeLessThan(QUALITY_TIERS[i - 1]!.particles);
    }
  });

  it("keeps the tier while frames fit the 60 fps budget", () => {
    const { state, changes } = feed(createQualityState(1), 12, window * 10);
    expect(changes).toBe(0);
    expect(state.tierIndex).toBe(1);
  });

  it("steps down once per slow window and stops at the cheapest tier", () => {
    const first = feed(createQualityState(0), 28, window);
    expect(first.changes).toBe(1);
    expect(first.state.tierIndex).toBe(1);
    const all = feed(createQualityState(0), 40, window * 20);
    expect(all.state.tierIndex).toBe(QUALITY_TIERS.length - 1);
    expect(all.changes).toBe(QUALITY_TIERS.length - 1);
  });

  it("ignores outliers such as tab switches", () => {
    const { state, changes } = feed(createQualityState(1), 900, window * 5);
    expect(changes).toBe(0);
    expect(state.samples).toHaveLength(0);
  });

  it("steps up only after several fast windows and a cooldown", () => {
    const slow = feed(createQualityState(1), 30, window).state;
    expect(slow.tierIndex).toBe(2);
    const shortFast = feed(slow, 6, window * DEFAULT_CONTROLLER_OPTIONS.upgradeWindows);
    expect(shortFast.state.tierIndex).toBe(2);
    let state = slow;
    let firstUpgradeWindow = -1;
    for (let w = 1; w <= 20 && firstUpgradeWindow < 0; w += 1) {
      const next = feed(state, 6, window);
      state = next.state;
      if (next.changes > 0) firstUpgradeWindow = w;
    }
    expect(firstUpgradeWindow).toBeGreaterThanOrEqual(DEFAULT_CONTROLLER_OPTIONS.upgradeWindows);
    expect(firstUpgradeWindow).toBeGreaterThanOrEqual(DEFAULT_CONTROLLER_OPTIONS.cooldownWindows);
    expect(state.tierIndex).toBe(1);
  });

  it("caps the number of upgrades to avoid oscillation", () => {
    let state = createQualityState(3);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      state = feed(state, 5, window * 20).state;
    }
    expect(state.upgrades).toBe(DEFAULT_CONTROLLER_OPTIONS.maxUpgrades);
    expect(state.tierIndex).toBe(3 - DEFAULT_CONTROLLER_OPTIONS.maxUpgrades);
  });
});

describe("initial tier from GPU hints", () => {
  const base = { renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4)", hardwareConcurrency: 10, coarsePointer: false, saveData: false };

  it("starts Apple Silicon on the high tier", () => {
    expect(QUALITY_TIERS[initialTierIndex(base)]!.name).toBe("high");
  });

  it("starts software renderers and weak integrated GPUs on the low tier", () => {
    expect(initialTierIndex({ ...base, renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))" })).toBe(3);
    expect(initialTierIndex({ ...base, renderer: "ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11)" })).toBe(3);
    expect(initialTierIndex({ ...base, saveData: true })).toBe(3);
  });

  it("starts phones and small CPUs on the medium tier", () => {
    expect(initialTierIndex({ ...base, renderer: "Apple GPU", coarsePointer: true })).toBe(2);
    expect(initialTierIndex({ ...base, renderer: "Unknown", hardwareConcurrency: 4 })).toBe(2);
  });
});
