import { describe, expect, it } from "vitest";
import { stepSpring, type Spring } from "./spring";

function run(fps: number, seconds: number, target: number, omega = 5): Spring {
  let spring: Spring = { value: 0, velocity: 0 };
  const frames = Math.round(fps * seconds);
  for (let i = 0; i < frames; i += 1) spring = stepSpring(spring, target, omega, 1 / fps);
  return spring;
}

describe("critically damped spring", () => {
  it("moves the same way whatever the frame rate", () => {
    for (const seconds of [0.2, 0.5, 1, 1.5]) {
      const reference = run(240, seconds, 1).value;
      expect(run(30, seconds, 1).value).toBeCloseTo(reference, 9);
      expect(run(60, seconds, 1).value).toBeCloseTo(reference, 9);
      expect(run(120, seconds, 1).value).toBeCloseTo(reference, 9);
    }
  });

  it("approaches a still target monotonically, without overshoot", () => {
    let spring: Spring = { value: 0, velocity: 0 };
    let previous = 0;
    for (let i = 0; i < 300; i += 1) {
      spring = stepSpring(spring, 1, 5, 1 / 60);
      expect(spring.value).toBeGreaterThanOrEqual(previous);
      expect(spring.value).toBeLessThanOrEqual(1);
      previous = spring.value;
    }
    expect(spring.value).toBeCloseTo(1, 4);
  });

  it("starts gently: the first frame of a jump moves far less than a linear step would", () => {
    const first = stepSpring({ value: 0, velocity: 0 }, 1, 5, 1 / 60);
    expect(first.value).toBeLessThan(0.01);
    expect(first.velocity).toBeGreaterThan(0);
  });

  it("covers most of a step in about a second at omega 5", () => {
    expect(run(60, 1, 1).value).toBeGreaterThan(0.95);
    expect(run(60, 0.3, 1).value).toBeLessThan(0.5);
  });

  it("ignores empty frames", () => {
    const spring = { value: 0.3, velocity: 0.2 };
    expect(stepSpring(spring, 1, 5, 0)).toBe(spring);
  });
});
