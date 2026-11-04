import { LinearClass, ONE, SablierLinearStream } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { fractionAt, scheduleBounds, timelinePoints, unlockFunctionOf, type EngineSchedule } from "./unlock-schedule";

const linear: EngineSchedule & { kind: "Linear" } = {
  kind: "Linear",
  start: 1_700_000_000n,
  cliff: 1_702_592_000n,
  end: 1_731_536_000n,
  granularity: 1n,
  total: 10n,
  startUnlock: 0n,
  cliffUnlock: 1n,
  minDeposit: 10n ** 18n,
};

const stepped: EngineSchedule = { kind: "Stepped", start: 1_700_000_000n, end: 1_700_000_000n + 10n * 86_400n, period: 86_400n, amountPerPeriod: 1n, cliffAmount: 0n, total: 10n };

describe("unlockFunctionOf", () => {
  it("rebuilds a reduced linear class so that f(t) equals the class math of the original stream", () => {
    const stream = new SablierLinearStream({ start: linear.start, cliff: linear.cliff, end: linear.end, granularity: 1n, startUnlock: 0n, cliffUnlock: 100n * 10n ** 18n, deposited: 1000n * 10n ** 18n });
    const reference = LinearClass.fromStream(stream, 18);
    const rebuilt = unlockFunctionOf(linear, 18);
    for (const t of [linear.start - 1n, linear.start, linear.cliff - 1n, linear.cliff, linear.cliff + 1_000_000n, linear.end - 1n, linear.end]) {
      expect(rebuilt.fraction(t)).toBe(reference.fraction(t));
    }
    expect(fractionAt({ schedule: linear, decimals: 18 }, linear.end)).toBe(ONE);
    expect(fractionAt({ schedule: linear, decimals: 18 }, linear.cliff)).toBe(ONE / 10n);
  });
  it("rebuilds a stepped class", () => {
    const f = unlockFunctionOf(stepped, 9);
    expect(f.fraction(stepped.start - 1n)).toBe(0n);
    expect(f.fraction(stepped.start + 86_400n)).toBe(ONE / 10n);
    expect(f.fraction(stepped.start + 86_399n)).toBe(0n);
    expect(f.fraction(stepped.end)).toBe(ONE);
  });
});

describe("timelinePoints", () => {
  it("is sorted, spans the schedule and includes the breakpoints", () => {
    const points = timelinePoints({ schedule: linear, decimals: 18 }, 50);
    const times = points.map((point) => point.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times).toContain(Number(linear.start));
    expect(times).toContain(Number(linear.cliff));
    expect(times).toContain(Number(linear.end));
    expect(points[0]?.fraction).toBe(0);
    expect(points[points.length - 1]?.fraction).toBe(1);
    const atCliff = points.find((point) => point.t === Number(linear.cliff));
    expect(atCliff?.fraction).toBeCloseTo(0.1, 6);
  });
  it("renders stepped schedules as steps with points before and at each boundary", () => {
    const points = timelinePoints({ schedule: stepped, decimals: 9 }, 20);
    const boundary = Number(stepped.start) + 86_400;
    const before = points.find((point) => point.t === boundary - 1);
    const at = points.find((point) => point.t === boundary);
    expect(before?.fraction).toBe(0);
    expect(at?.fraction).toBeCloseTo(0.1, 6);
    expect(scheduleBounds(stepped)).toEqual({ start: stepped.start, cliff: null, end: stepped.end });
  });
});
