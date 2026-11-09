import { describe, expect, it } from "vitest";
import { PHASES, SWEEPS, sequenceAt } from "./timeline";

const samples = Array.from({ length: 801 }, (_, i) => i / 800);
const first = SWEEPS[0]!;
const second = SWEEPS[1]!;

describe("landing sequence timeline", () => {
  it("opens on the dragon asleep under the phrase, with only the rose smoldering", () => {
    const start = sequenceAt(0);
    expect(start.dolly).toBe(0);
    expect(start.retreat).toBe(0);
    expect(start.wake).toBe(0);
    expect(start.eyelid).toBe(0);
    expect(start.fire).toBe(0);
    expect(start.cracks).toEqual([0, 0]);
    expect(start.phrase).toBe(0);
    expect(start.shatter).toBe(0);
    expect(start.rose).toBeGreaterThan(0);
    expect(start.smoke).toBeGreaterThan(0);
    expect(start.tail).toBeGreaterThan(0);
    expect(start.launchReady).toBe(false);
  });

  it("closes in on the dragon before it wakes, and wakes it before the first breath", () => {
    const closeUp = samples.find((p) => sequenceAt(p).dolly > 0.5)!;
    const awake = samples.find((p) => sequenceAt(p).wake > 0.5)!;
    const firstFire = samples.find((p) => sequenceAt(p).fire > 0)!;
    expect(closeUp).toBeLessThan(awake);
    expect(awake).toBeLessThan(firstFire);
    expect(sequenceAt(firstFire).wake).toBeGreaterThan(0.95);
    expect(sequenceAt(first.start).dolly).toBe(1);
  });

  it("breathes fire in exactly two sweeps, each travelling left to right across the phrase", () => {
    let previous: number | null = null;
    const sweepsSeen = new Set<number>();
    for (const p of samples) {
      const state = sequenceAt(p);
      const inSweep = SWEEPS.some((sweep) => p > sweep.start && p < sweep.end);
      if (!inSweep) expect(state.fire).toBe(0);
      if (state.fire > 0.5) sweepsSeen.add(state.sweep);
      if (state.sweep >= 0 && previous !== null && sequenceAt(p - 1 / 800).sweep === state.sweep) expect(state.aim).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = state.sweep >= 0 ? state.aim : null;
    }
    expect([...sweepsSeen]).toEqual([0, 1]);
    const peak = (sweep: (typeof SWEEPS)[number]) => {
      const inside = samples.filter((p) => p > sweep.start && p < sweep.end).map((p) => sequenceAt(p));
      const hot = inside.filter((state) => state.fire > 0.9);
      return { from: Math.min(...hot.map((s) => s.aim)), to: Math.max(...hot.map((s) => s.aim)) };
    };
    for (const sweep of [first, second]) {
      const { from, to } = peak(sweep);
      expect(from).toBeLessThan(0.1);
      expect(to).toBeGreaterThan(0.9);
    }
  });

  it("swings the head back to the left between the two sweeps", () => {
    expect(sequenceAt(first.end).aim).toBeCloseTo(1, 5);
    expect(sequenceAt(second.start).aim).toBeCloseTo(0, 5);
    expect(sequenceAt((first.end + second.start) / 2).fire).toBe(0);
  });

  it("cracks the phrase with each sweep, monotonically", () => {
    let previous = [0, 0];
    for (const p of samples) {
      const { cracks } = sequenceAt(p);
      expect(cracks[0]).toBeGreaterThanOrEqual(previous[0]! - 1e-9);
      expect(cracks[1]).toBeGreaterThanOrEqual(previous[1]! - 1e-9);
      previous = [...cracks];
    }
    expect(sequenceAt(first.end).cracks).toEqual([1, 0]);
    expect(sequenceAt(second.end).cracks).toEqual([1, 1]);
  });

  it("makes rose blaze once the first sweep has reached it", () => {
    expect(sequenceAt(first.end).rose).toBeGreaterThan(sequenceAt(first.start).rose + 0.6);
  });

  it("grows, raises and shatters the phrase while the fire burns, gone before the end", () => {
    expect(sequenceAt(first.start).phrase).toBeGreaterThan(0);
    expect(sequenceAt(second.end).phrase).toBeGreaterThan(sequenceAt(first.end).phrase);
    expect(PHASES.shatter[0]).toBeGreaterThan(second.start);
    expect(PHASES.shatter[0]).toBeLessThan(second.end);
    expect(sequenceAt(PHASES.shatter[1]).shatter).toBe(1);
    expect(PHASES.shatter[1]).toBeLessThan(1);
  });

  it("falls back asleep after the fire, then pulls back to a small dragon", () => {
    expect(PHASES.sleep[0]).toBeGreaterThanOrEqual(second.end);
    expect(PHASES.retreat[0]).toBeGreaterThanOrEqual(second.end);
    const end = sequenceAt(1);
    expect(end.eyelid).toBe(0);
    expect(end.sleep).toBe(1);
    expect(end.smoke).toBe(1);
    expect(end.tail).toBe(1);
    expect(end.fire).toBe(0);
    expect(end.retreat).toBe(1);
    expect(end.shatter).toBe(1);
    expect(end.launchReady).toBe(true);
  });

  it("clamps out-of-range progress", () => {
    expect(sequenceAt(-1)).toEqual(sequenceAt(0));
    expect(sequenceAt(2)).toEqual(sequenceAt(1));
  });
});
