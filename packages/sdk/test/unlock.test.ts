import { describe, expect, it } from "vitest";

import { ONE, U64_MAX } from "../src/math.js";
import {
  accrual,
  LinearClass,
  SablierLinearStream,
  ScheduleError,
  SteppedClass,
  StreamflowStream,
} from "../src/unlock.js";
import type { SablierLinearParams, StreamflowParams } from "../src/unlock.js";
import { loadUnlockVectors } from "./vectors.js";

const vectors = loadUnlockVectors();

function scheduleErrorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ScheduleError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

const baseParams: SablierLinearParams = {
  start: 1_000n,
  cliff: 2_000n,
  end: 11_000n,
  granularity: 1n,
  startUnlock: 100n,
  cliffUnlock: 200n,
  deposited: 10_000n,
};

describe("unlock vectors", () => {
  it("use the same fixed-point one", () => {
    expect(vectors.one).toBe(ONE);
  });

  describe("sablier linear", () => {
    for (const vector of vectors.sablierLinear) {
      it(vector.name, () => {
        const stream = new SablierLinearStream(vector.input);
        const klass = LinearClass.fromStream(stream, vector.input.tokenDecimals);
        expect({
          kind: klass.kind,
          start: klass.start,
          cliff: klass.cliff,
          end: klass.end,
          granularity: klass.granularity,
          startUnlock: klass.startUnlock,
          cliffUnlock: klass.cliffUnlock,
          total: klass.total,
          minDeposit: klass.minDeposit,
          margin: klass.margin(),
        }).toEqual(vector.class);
        for (const point of vector.points) {
          expect(stream.streamedAmount(point.t), `streamed at ${point.t.toString()}`).toBe(point.streamed);
          expect(klass.fraction(point.t), `fraction at ${point.t.toString()}`).toBe(point.fraction);
        }
      });
    }
  });

  describe("streamflow", () => {
    for (const vector of vectors.streamflow) {
      it(vector.name, () => {
        const stream = new StreamflowStream(vector.input);
        const klass = SteppedClass.fromStream(stream);
        expect({
          kind: klass.kind,
          start: klass.start,
          end: klass.end,
          period: klass.period,
          cliffAmount: klass.cliffAmount,
          amountPerPeriod: klass.amountPerPeriod,
          total: klass.total,
        }).toEqual(vector.class);
        for (const point of vector.points) {
          expect(stream.unlockedAmount(point.t), `unlocked at ${point.t.toString()}`).toBe(point.unlocked);
          expect(klass.fraction(point.t), `fraction at ${point.t.toString()}`).toBe(point.fraction);
        }
      });
    }
  });

  describe("accrual", () => {
    for (const [k, vector] of vectors.accrual.entries()) {
      it(`case ${String(k)}`, () => {
        expect(accrual(vector.balance, vector.from, vector.to)).toBe(vector.accrual);
      });
    }
  });
});

describe("sablier validation", () => {
  it("accepts every stream Sablier can create and keeps a copy of the parameters", () => {
    const stream = new SablierLinearStream(baseParams);
    expect(stream.params).toEqual(baseParams);
    expect(stream.params).not.toBe(baseParams);
  });

  it("mirrors Sablier's creation checks", () => {
    const refused = (params: SablierLinearParams, code: string): void => {
      expect(scheduleErrorCode(() => new SablierLinearStream(params))).toBe(code);
    };
    refused({ ...baseParams, deposited: 0n }, "zero_deposit");
    refused({ ...baseParams, start: 0n }, "zero_start_time");
    refused({ ...baseParams, cliff: 1_000n }, "start_not_before_cliff");
    refused({ ...baseParams, cliff: 11_000n }, "cliff_not_before_end");
    refused({ ...baseParams, cliff: 0n }, "cliff_unlock_without_cliff");
    refused({ ...baseParams, cliff: 0n, cliffUnlock: 0n, end: 1_000n }, "start_not_before_end");
    refused({ ...baseParams, granularity: 0n }, "zero_granularity");
    refused({ ...baseParams, granularity: 9_001n }, "granularity_too_high");
    refused({ ...baseParams, startUnlock: 9_801n }, "unlock_amounts_exceed_deposit");
    refused({ ...baseParams, startUnlock: 2n ** 128n - 1n }, "unlock_amounts_exceed_deposit");
    expect(new ScheduleError("zero_period").message).toBe("unlock period is zero");
  });

  it("rejects parameters outside their integer domains", () => {
    expect(() => new SablierLinearStream({ ...baseParams, end: U64_MAX + 1n })).toThrow(RangeError);
    expect(() => new SablierLinearStream({ ...baseParams, deposited: -1n })).toThrow(RangeError);
    expect(() => new SablierLinearStream(baseParams).streamedAmount(-1n)).toThrow(RangeError);
  });

  it("refuses classes below one whole token or with unrepresentable decimals", () => {
    const small = new SablierLinearStream({
      ...baseParams,
      deposited: 1_000_000n,
      startUnlock: 10_000n,
      cliffUnlock: 20_000n,
    });
    const large = new SablierLinearStream({
      ...baseParams,
      deposited: 3_000_000n,
      startUnlock: 30_000n,
      cliffUnlock: 60_000n,
    });
    expect(LinearClass.fromStream(small, 6)).toEqual(LinearClass.fromStream(large, 6));
    expect(LinearClass.fromStream(small, 6)).not.toEqual(LinearClass.fromStream(large, 5));
    expect(scheduleErrorCode(() => LinearClass.fromStream(small, 7))).toBe("deposit_below_minimum");
    expect(scheduleErrorCode(() => LinearClass.fromStream(small, 39))).toBe("token_decimals_too_large");
    expect(() => LinearClass.fromStream(small, 300)).toThrow(RangeError);
  });
});

describe("streamflow validation", () => {
  const params: StreamflowParams = {
    startTime: 100n,
    cliff: 200n,
    cliffAmount: 50n,
    period: 10n,
    amountPerPeriod: 10n,
    netAmountDeposited: 1_000n,
    endTime: 1_160n,
  };

  it("refuses what the engine refuses", () => {
    const refused = (p: StreamflowParams, code: string): void => {
      expect(scheduleErrorCode(() => new StreamflowStream(p))).toBe(code);
    };
    refused({ ...params, netAmountDeposited: 0n }, "zero_deposit");
    refused({ ...params, period: 0n }, "zero_period");
    refused({ ...params, cliffAmount: 1_001n }, "cliff_amount_exceeds_deposit");
    refused({ ...params, endTime: 199n }, "end_before_start");
    refused({ ...params, cliff: 0n, endTime: 99n }, "end_before_start");
    expect(() => new StreamflowStream({ ...params, cliffAmount: U64_MAX + 1n })).toThrow(RangeError);
  });

  it("normalizes amounts and the effective start", () => {
    const a = new StreamflowStream(params);
    const b = new StreamflowStream({
      ...params,
      startTime: 150n,
      cliffAmount: 150n,
      amountPerPeriod: 30n,
      netAmountDeposited: 3_000n,
    });
    const c = new StreamflowStream({ ...params, amountPerPeriod: 11n });
    expect(SteppedClass.fromStream(a)).toEqual(SteppedClass.fromStream(b));
    expect(SteppedClass.fromStream(a)).not.toEqual(SteppedClass.fromStream(c));
    expect(a.effectiveStart()).toBe(200n);
    expect(new StreamflowStream({ ...params, cliff: 0n }).effectiveStart()).toBe(100n);
  });
});

describe("accrual", () => {
  it("is the floor of the fraction delta and never negative", () => {
    expect(accrual(1_000n, 0n, ONE / 3n)).toBe(333n);
    expect(accrual(1_000n, ONE / 3n, ONE / 3n)).toBe(0n);
    expect(accrual(1_000n, ONE, 0n)).toBe(0n);
    expect(() => accrual(-1n, 0n, ONE)).toThrow(RangeError);
  });
});
