import { describe, expect, it } from "vitest";
import { EASE, PHASES, SWEEPS, keyframes, sequenceAt } from "./timeline";

const samples = Array.from({ length: 2001 }, (_, i) => i / 2000);
const first = SWEEPS[0]!;
const second = SWEEPS[1]!;

/** Largest change of a channel between two neighbouring samples, a proxy for its steepest slope. */
function maxStep(channel: (p: number) => number): number {
  let largest = 0;
  for (let i = 1; i < samples.length; i += 1) largest = Math.max(largest, Math.abs(channel(samples[i]!) - channel(samples[i - 1]!)));
  return largest;
}

describe("easing and keyframes", () => {
  it("eases every curve from 0 to 1 with a flat start", () => {
    for (const ease of Object.values(EASE)) {
      expect(ease(0)).toBeCloseTo(0, 9);
      expect(ease(1)).toBeCloseTo(1, 9);
    }
    expect(EASE.inOutQuint(0.01)).toBeLessThan(1e-5);
    expect(EASE.inOutCubic(0.5)).toBeCloseTo(0.5, 9);
  });

  it("interpolates between keys and holds the end values", () => {
    const keys = [
      [0.2, 0],
      [0.4, 1, EASE.linear],
      [0.6, 0.5],
    ] as const;
    expect(keyframes(keys, 0)).toBe(0);
    expect(keyframes(keys, 0.3)).toBeCloseTo(0.5, 9);
    expect(keyframes(keys, 0.5)).toBeCloseTo(0.75, 9);
    expect(keyframes(keys, 1)).toBe(0.5);
  });
});

describe("landing sequence timeline", () => {
  it("opens on the dragon asleep under the phrase, with only the rose smoldering", () => {
    const start = sequenceAt(0);
    expect(start.dolly).toBe(0);
    expect(start.retreat).toBe(0);
    expect(start.wake).toBe(0);
    expect(start.neck.every((joint) => joint === 0)).toBe(true);
    expect(start.wingFold).toBe(1);
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

  it("brings the dragon to its full size before it wakes, and keeps it there until after the fire", () => {
    const awake = samples.find((p) => sequenceAt(p).wake > 0.5)!;
    expect(sequenceAt(PHASES.dolly[1]).dolly).toBe(1);
    expect(PHASES.dolly[1]).toBeLessThan(awake);
    expect(PHASES.retreat[0]).toBeGreaterThanOrEqual(second.end);
    for (const p of samples.filter((q) => q >= PHASES.dolly[1] && q <= second.end)) {
      expect(sequenceAt(p).dolly).toBe(1);
      expect(sequenceAt(p).retreat).toBe(0);
    }
  });

  it("wakes in stages: eyes first, then the neck from its base, then the wing spreads", () => {
    const eyesOpen = samples.find((p) => sequenceAt(p).eyelid > 0.1)!;
    const neckBase = samples.find((p) => sequenceAt(p).neck[0]! > 0.1)!;
    const head = samples.find((p) => sequenceAt(p).neck.at(-1)! > 0.1)!;
    const wing = samples.find((p) => sequenceAt(p).wingFold < 0.5)!;
    expect(eyesOpen).toBeLessThan(neckBase);
    expect(neckBase).toBeLessThan(head);
    expect(head).toBeLessThan(wing);
    // The wing lifts, holds a beat, then spreads past its rest pose before it settles.
    expect(sequenceAt(0.3).wingFold).toBeGreaterThan(0.6);
    expect(Math.min(...samples.map((p) => sequenceAt(p).wingFold))).toBeLessThan(0);
    expect(sequenceAt(first.start).wingFold).toBe(0);
  });

  it("is fully awake and holds its breath before the first sweep", () => {
    const beforeFire = sequenceAt(first.start - 0.012);
    expect(beforeFire.wake).toBe(1);
    expect(beforeFire.neck.every((joint) => joint === 1)).toBe(true);
    expect(beforeFire.eyelid).toBe(1);
    expect(beforeFire.focus).toBe(1);
    expect(beforeFire.inhale).toBe(1);
    expect(sequenceAt(first.start + 0.01).inhale).toBeLessThan(0.7);
    expect(sequenceAt(first.start + 0.03).inhale).toBe(0);
    expect(sequenceAt(PHASES.inhale[0] - 0.01).inhale).toBe(0);
  });

  it("moves every body channel without jumps", () => {
    const limit = 0.02;
    expect(maxStep((p) => sequenceAt(p).dolly)).toBeLessThan(limit);
    expect(maxStep((p) => sequenceAt(p).retreat)).toBeLessThan(limit);
    expect(maxStep((p) => sequenceAt(p).wake)).toBeLessThan(limit);
    expect(maxStep((p) => sequenceAt(p).wingFold)).toBeLessThan(limit);
    expect(maxStep((p) => sequenceAt(p).inhale)).toBeLessThan(limit);
    expect(maxStep((p) => sequenceAt(p).eyelid)).toBeLessThan(limit);
    for (let joint = 0; joint < sequenceAt(0).neck.length; joint += 1) {
      expect(maxStep((p) => sequenceAt(p).neck[joint]!)).toBeLessThan(limit);
    }
  });

  it("breathes fire in exactly two sweeps, each travelling left to right across the phrase", () => {
    let previous: number | null = null;
    const sweepsSeen = new Set<number>();
    for (const p of samples) {
      const state = sequenceAt(p);
      const inSweep = SWEEPS.some((sweep) => p > sweep.start && p < sweep.end);
      if (!inSweep) expect(state.fire).toBe(0);
      if (state.fire > 0.5) sweepsSeen.add(state.sweep);
      if (state.sweep >= 0 && previous !== null && sequenceAt(p - 1 / 2000).sweep === state.sweep) expect(state.aim).toBeGreaterThanOrEqual(previous - 1e-9);
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

  it("falls back asleep after the fire, the head sinking before the neck base, then pulls back", () => {
    expect(PHASES.sleep[0]).toBeGreaterThanOrEqual(second.end);
    const headDown = samples.find((p) => p > second.end && sequenceAt(p).neck.at(-1)! < 0.9)!;
    const baseDown = samples.find((p) => p > second.end && sequenceAt(p).neck[0]! < 0.9)!;
    expect(headDown).toBeLessThan(baseDown);
    const end = sequenceAt(1);
    expect(end.neck.every((joint) => joint === 0)).toBe(true);
    expect(end.wingFold).toBe(1);
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
