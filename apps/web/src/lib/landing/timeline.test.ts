import { describe, expect, it } from "vitest";
import { FIRE_PULSES, PHASES, sequenceAt } from "./timeline";

const samples = Array.from({ length: 401 }, (_, i) => i / 400);

describe("landing sequence timeline", () => {
  it("starts in the dark with only the rose smoldering", () => {
    const start = sequenceAt(0);
    expect(start.eyes).toBe(0);
    expect(start.body).toBe(0);
    expect(start.fire).toBe(0);
    expect(start.front).toBe(0);
    expect(start.rose).toBeGreaterThan(0);
    expect(start.launchReady).toBe(false);
  });

  it("lights the eyes before the body emerges", () => {
    const firstEyes = samples.find((p) => sequenceAt(p).eyes > 0.5)!;
    const firstBody = samples.find((p) => sequenceAt(p).body > 0.5)!;
    expect(firstEyes).toBeLessThan(firstBody);
    expect(sequenceAt(firstEyes).body).toBeLessThan(0.1);
  });

  it("breathes fire only in pulses and moves the flame front monotonically to the last letter", () => {
    let previous = 0;
    for (const p of samples) {
      const state = sequenceAt(p);
      expect(state.front).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = state.front;
      const inPulse = FIRE_PULSES.some((pulse) => p > pulse.start && p < pulse.end);
      if (!inPulse) expect(state.fire).toBe(0);
    }
    expect(sequenceAt(FIRE_PULSES[2]!.end).front).toBe(1);
    expect(Math.max(...samples.map((p) => sequenceAt(p).fire))).toBeGreaterThan(0.9);
  });

  it("makes rose glow brighter as the flame reaches it", () => {
    const before = sequenceAt(FIRE_PULSES[0]!.start).rose;
    const after = sequenceAt(FIRE_PULSES[2]!.end).rose;
    expect(after).toBeGreaterThan(before + 0.4);
  });

  it("sends the phrase out through the top before the dragon falls asleep", () => {
    expect(sequenceAt(PHASES.phraseExit[1]).phraseExit).toBe(1);
    expect(PHASES.phraseExit[0]).toBeGreaterThanOrEqual(FIRE_PULSES[2]!.end);
  });

  it("ends asleep: eyes closed, smoke drifting, tail glowing, launch ready", () => {
    const end = sequenceAt(1);
    expect(end.eyelid).toBe(0);
    expect(end.sleep).toBe(1);
    expect(end.smoke).toBe(1);
    expect(end.tail).toBe(1);
    expect(end.fire).toBe(0);
    expect(end.launchReady).toBe(true);
  });

  it("clamps out-of-range progress", () => {
    expect(sequenceAt(-1)).toEqual(sequenceAt(0));
    expect(sequenceAt(2)).toEqual(sequenceAt(1));
  });
});
