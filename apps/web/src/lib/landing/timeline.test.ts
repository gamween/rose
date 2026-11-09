import { describe, expect, it } from "vitest";
import { EASE, PHASES, SPINE_LAG, SWEEPS, bodyAt, keyframes, sequenceAt } from "./timeline";

const samples = Array.from({ length: 2001 }, (_, i) => i / 2000);
const first = SWEEPS[0]!;
const second = SWEEPS[1]!;

/** Largest change of a channel between two neighbouring samples, a proxy for its steepest slope. */
function maxStep(channel: (p: number) => number): number {
  let largest = 0;
  for (let i = 1; i < samples.length; i += 1) largest = Math.max(largest, Math.abs(channel(samples[i]!) - channel(samples[i - 1]!)));
  return largest;
}

/** First sample at which `condition` holds. */
function firstWhere(condition: (p: number) => boolean): number {
  return samples.find(condition)!;
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
  it("opens on the dark: the dragon unseen, eye shut, under the phrase where only the rose smolders", () => {
    const start = sequenceAt(0);
    expect(start.reveal).toBe(0);
    expect(start.eyes).toBe(0);
    expect(start.smoke).toBe(0);
    expect(start.dolly).toBe(0);
    expect(start.frame).toBe(0);
    expect(start.retreat).toBe(0);
    expect(start.wake).toBe(0);
    expect(start.stand).toBe(0);
    expect(start.rise).toBe(0);
    expect(start.thrust).toBe(0);
    expect(start.wingFold).toBe(1);
    expect(start.wingSpread).toBe(0);
    expect(start.eyelid).toBe(0);
    expect(start.fire).toBe(0);
    expect(start.cracks).toEqual([0, 0]);
    expect(start.phrase).toBe(0);
    expect(start.rose).toBeGreaterThan(0);
    expect(start.tail).toBeGreaterThan(0);
    expect(start.launchReady).toBe(false);
  });

  it("moves the camera and opens the eye from the very first scroll, then spreads the light from it", () => {
    expect(sequenceAt(0.002).dolly).toBeGreaterThan(0.01);
    expect(sequenceAt(0.002).eyelid).toBeGreaterThan(0.05);
    expect(sequenceAt(0.002).eyes).toBeGreaterThan(0);
    expect(sequenceAt(0.002).reveal).toBe(0);
    const opened = firstWhere((p) => sequenceAt(p).eyelid > 0.9);
    const revealing = firstWhere((p) => sequenceAt(p).reveal > 0);
    const shown = firstWhere((p) => sequenceAt(p).reveal >= 1);
    expect(revealing).toBeLessThan(opened);
    expect(shown).toBeLessThan(sequenceAt(1).dolly > 0 ? PHASES.wake[1] : 1);
    expect(sequenceAt(1).reveal).toBe(1);
  });

  it("closes in to the full size before the dragon wakes, and pulls back only once it lies asleep again", () => {
    const awake = firstWhere((p) => sequenceAt(p).wake > 0.5);
    expect(sequenceAt(PHASES.dolly[1]).dolly).toBe(1);
    expect(PHASES.dolly[1]).toBeLessThan(awake);
    const lying = firstWhere((p) => p > PHASES.breath[1] && sequenceAt(p).stand === 0);
    expect(PHASES.retreat[0]).toBeGreaterThanOrEqual(lying - 0.011);
    for (const p of samples.filter((q) => q >= PHASES.dolly[1] && q <= PHASES.retreat[0])) {
      expect(sequenceAt(p).dolly).toBe(1);
      expect(sequenceAt(p).retreat).toBe(0);
    }
  });

  it("eases the camera to the standing frame as the dragon rears up", () => {
    expect(sequenceAt(PHASES.stand[0]).frame).toBeLessThan(0.3);
    expect(sequenceAt(PHASES.stand[1]).frame).toBe(1);
    expect(sequenceAt(1).frame).toBe(1);
  });

  it("wakes in stages: eyes, then it uncurls and lifts its neck, then it rears up as its wings unfold", () => {
    const eyesOpen = firstWhere((p) => sequenceAt(p).eyelid > 0.1);
    const uncurling = firstWhere((p) => sequenceAt(p).rise > 0.1);
    const risen = firstWhere((p) => sequenceAt(p).rise > 0.9);
    const rearing = firstWhere((p) => sequenceAt(p).stand > 0.1);
    const lifted = firstWhere((p) => sequenceAt(p).wingFold < 0.7);
    const spread = firstWhere((p) => sequenceAt(p).wingSpread > 0.9);
    expect(eyesOpen).toBeLessThan(uncurling);
    expect(uncurling).toBeLessThan(risen);
    expect(risen).toBeLessThan(rearing);
    expect(lifted).toBeGreaterThan(PHASES.stand[0]);
    expect(lifted).toBeLessThan(spread);
    expect(sequenceAt(spread).stand).toBeGreaterThan(0.9);
    // It rears past its full height and settles back: the follow-through.
    expect(Math.max(...samples.map((p) => sequenceAt(p).stand))).toBeGreaterThan(1.02);
    expect(sequenceAt(0.42).stand).toBe(1);
    // The wings lift, hold a beat, then rise past their full spread before they settle.
    expect(sequenceAt(0.335).wingFold).toBeGreaterThan(0.55);
    expect(Math.min(...samples.map((p) => sequenceAt(p).wingFold))).toBeLessThan(0);
    expect(Math.max(...samples.map((p) => sequenceAt(p).wingSpread))).toBeGreaterThan(1);
  });

  it("breathes fire as it reaches the top of its rear, wings spread, with no pause before", () => {
    const peak = Math.max(...samples.map((p) => sequenceAt(p).stand));
    const top = firstWhere((p) => sequenceAt(p).stand >= peak);
    expect(sequenceAt(top).fire).toBeGreaterThan(0.5);
    expect(PHASES.breath[0]).toBeLessThan(PHASES.stand[1]);
    expect(PHASES.breath[0]).toBeGreaterThan(PHASES.stand[0] + 0.05);
    const blazing = firstWhere((p) => sequenceAt(p).fire >= 1);
    const state = sequenceAt(blazing);
    expect(state.wake).toBe(1);
    expect(state.rise).toBe(1);
    expect(state.stand).toBeGreaterThan(0.99);
    expect(state.thrust).toBeGreaterThan(0.95);
    expect(state.focus).toBeGreaterThan(0.95);
    expect(state.eyelid).toBe(1);
    // The first flame goes up the middle, then the head swings left for the first pass.
    expect(sequenceAt(PHASES.breath[0] + 0.01).aim).toBeCloseTo(0.5, 5);
    expect(sequenceAt(first.start).aim).toBeCloseTo(0, 5);
    for (const p of samples.filter((q) => q > PHASES.breath[0] && q < first.start)) expect(sequenceAt(p).aim).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("makes the second pass far stronger than the first", () => {
    const during = (sweep: (typeof SWEEPS)[number]) => sequenceAt((sweep.start + sweep.end) / 2).power;
    expect(during(first)).toBe(1);
    expect(during(second)).toBeGreaterThan(1.6);
    expect(sequenceAt((second.start + second.end) / 2).thrust).toBeGreaterThan(sequenceAt((first.start + first.end) / 2).thrust);
  });

  it("breathes one hard, sustained jet until the phrase has left the screen through the top", () => {
    const blazing = firstWhere((p) => sequenceAt(p).fire >= 1);
    const gone = firstWhere((p) => sequenceAt(p).phrase >= 1);
    expect(blazing).toBeLessThan(first.start);
    expect(gone).toBeGreaterThan(second.end);
    for (const p of samples) {
      const state = sequenceAt(p);
      if (p <= PHASES.breath[0] || p >= PHASES.breath[1]) expect(state.fire).toBe(0);
      if (p >= blazing && p <= gone) expect(state.fire).toBeGreaterThan(0.8);
      if (p >= gone) expect(state.phrase).toBe(1);
    }
    expect(sequenceAt(gone).fire).toBe(1);
    expect(sequenceAt(PHASES.breath[1]).fire).toBe(0);
  });

  it("sweeps the jet twice from left to right across the phrase, swinging back between the sweeps", () => {
    for (const sweep of SWEEPS) {
      const inside = samples.filter((p) => p > sweep.start && p < sweep.end);
      for (let i = 1; i < inside.length; i += 1) expect(sequenceAt(inside[i]!).aim).toBeGreaterThanOrEqual(sequenceAt(inside[i - 1]!).aim - 1e-9);
      expect(Math.min(...inside.map((p) => sequenceAt(p).aim))).toBeLessThan(0.05);
      expect(Math.max(...inside.map((p) => sequenceAt(p).aim))).toBeGreaterThan(0.95);
      expect(inside.every((p) => sequenceAt(p).fire > 0.95)).toBe(true);
    }
    expect([...new Set(samples.map((p) => sequenceAt(p).sweep))].filter((index) => index >= 0)).toEqual([0, 1]);
    expect(sequenceAt(first.end).aim).toBeCloseTo(1, 5);
    expect(sequenceAt(second.start).aim).toBeCloseTo(0, 5);
    expect(sequenceAt((first.end + second.start) / 2).fire).toBeGreaterThan(0.8);
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

  it("raises the phrase with the dragon, then drives it up faster and faster, never back down", () => {
    let previous = 0;
    for (const p of samples) {
      const { phrase } = sequenceAt(p);
      expect(phrase).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = phrase;
    }
    expect(sequenceAt(PHASES.stand[1]).phrase).toBeGreaterThan(0.2);
    const early = sequenceAt(first.end).phrase - sequenceAt(first.start).phrase;
    const late = sequenceAt(second.end).phrase - sequenceAt(second.start).phrase;
    expect(late).toBeGreaterThan(early * 1.5);
  });

  it("calms down after the fire: wings fold in stages, then it lowers onto all fours and falls asleep", () => {
    const furled = firstWhere((p) => p > PHASES.breath[1] && sequenceAt(p).wingSpread < 0.6);
    const lowering = firstWhere((p) => p > PHASES.breath[1] && sequenceAt(p).stand < 0.95);
    const down = firstWhere((p) => p > PHASES.breath[1] && sequenceAt(p).stand === 0);
    const asleep = firstWhere((p) => p > PHASES.breath[1] && sequenceAt(p).eyelid === 0);
    expect(furled).toBeLessThan(lowering);
    expect(lowering).toBeLessThan(down);
    expect(down).toBeLessThanOrEqual(asleep);
    expect(sequenceAt(PHASES.breath[1] + 0.01).heave).toBeGreaterThan(0.5);
    const curling = firstWhere((p) => p > PHASES.breath[1] && sequenceAt(p).rise < 0.9);
    expect(lowering).toBeLessThan(curling);
    const end = sequenceAt(1);
    expect(end.rise).toBe(0);
    expect(end.stand).toBe(0);
    expect(end.wingFold).toBe(1);
    expect(end.wingSpread).toBe(0);
    expect(end.eyelid).toBe(0);
    expect(end.sleep).toBe(1);
    expect(end.smoke).toBe(1);
    expect(end.tail).toBe(1);
    expect(end.fire).toBe(0);
    expect(end.retreat).toBe(1);
    expect(end.phrase).toBe(1);
    expect(end.launchReady).toBe(true);
  });

  it("moves every body and camera channel without jumps", () => {
    const limit = 0.02;
    const channels: ((p: number) => number)[] = [
      (p) => sequenceAt(p).dolly,
      (p) => sequenceAt(p).frame,
      (p) => sequenceAt(p).retreat,
      (p) => sequenceAt(p).wake,
      (p) => sequenceAt(p).stand,
      (p) => sequenceAt(p).rise,
      (p) => sequenceAt(p).thrust,
      (p) => sequenceAt(p).wingFold,
      (p) => sequenceAt(p).wingSpread,
      (p) => sequenceAt(p).reveal,
      (p) => sequenceAt(p).power,
      (p) => sequenceAt(p).heave,
      (p) => sequenceAt(p).eyelid,
      (p) => sequenceAt(p).phrase,
    ];
    for (const channel of channels) expect(maxStep(channel)).toBeLessThan(limit);
  });

  it("pushes forward into the jet as the fire comes out, and holds there until the fire dies", () => {
    expect(sequenceAt(PHASES.breath[0] - 0.02).thrust).toBeLessThan(0.3);
    expect(sequenceAt(first.start).thrust).toBeGreaterThan(0.6);
    expect(Math.max(...samples.map((p) => sequenceAt(p).thrust))).toBeGreaterThan(1.05);
    for (const p of samples.filter((q) => q > first.start && q < second.end)) expect(sequenceAt(p).thrust).toBeGreaterThan(0.95);
    expect(sequenceAt(PHASES.breath[1] + 0.03).thrust).toBe(0);
  });

  it("gives the body channels on their own, for the bones that sample them a little later", () => {
    for (const p of [0.1, 0.3, 0.45, 0.6, 0.85]) {
      const { rise, stand, thrust } = sequenceAt(p);
      expect(bodyAt(p)).toEqual({ rise, stand, thrust });
    }
    expect(SPINE_LAG).toBeGreaterThan(0);
    expect(SPINE_LAG * 12).toBeLessThan(0.06);
  });

  it("clamps out-of-range progress", () => {
    expect(sequenceAt(-1)).toEqual(sequenceAt(0));
    expect(sequenceAt(2)).toEqual(sequenceAt(1));
  });
});
