import { describe, expect, it } from "vitest";

import {
  assertU128,
  assertU64,
  assertU8,
  MathError,
  mulDivCeil,
  mulDivFloor,
  mulDivRem,
  mulDivWide,
  ONE,
  pow10,
  U128_MAX,
  U64_MAX,
} from "../src/math.js";

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof MathError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

describe("math", () => {
  it("floor and ceil round in opposite directions", () => {
    expect(mulDivFloor(7n, 3n, 2n)).toBe(10n);
    expect(mulDivCeil(7n, 3n, 2n)).toBe(11n);
    expect(mulDivFloor(6n, 3n, 2n)).toBe(9n);
    expect(mulDivCeil(6n, 3n, 2n)).toBe(9n);
  });

  it("full-width products do not overflow", () => {
    expect(mulDivFloor(U128_MAX, U128_MAX, U128_MAX)).toBe(U128_MAX);
    expect(mulDivCeil(U128_MAX, ONE, ONE)).toBe(U128_MAX);
    expect(mulDivWide([U128_MAX, U128_MAX, 3n], [U128_MAX, U128_MAX], "down")).toBe(3n);
  });

  it("errors carry the engine's codes", () => {
    expect(errorCode(() => mulDivFloor(1n, 1n, 0n))).toBe("division_by_zero");
    expect(errorCode(() => mulDivFloor(U128_MAX, 2n, 1n))).toBe("overflow");
    expect(errorCode(() => mulDivWide([U128_MAX, U128_MAX, U128_MAX, U128_MAX, U128_MAX], [1n], "down"))).toBe(
      "overflow",
    );
    expect(errorCode(() => mulDivWide([1n], [0n], "up"))).toBe("division_by_zero");
    expect(errorCode(() => mulDivRem(1n, 1n, 0n))).toBe("division_by_zero");
    expect(errorCode(() => pow10(39))).toBe("overflow");
    expect(new MathError("overflow").message).toBe("arithmetic overflow");
    expect(new MathError("division_by_zero").message).toBe("division by zero");
  });

  it("four full-width factors fit in 512 bits, five do not", () => {
    expect(mulDivWide([U128_MAX, U128_MAX, U128_MAX, U128_MAX], [U128_MAX, U128_MAX, U128_MAX], "down")).toBe(
      U128_MAX,
    );
    expect(errorCode(() => mulDivWide([U128_MAX, U128_MAX, U128_MAX, U128_MAX, 2n], [U128_MAX], "down"))).toBe(
      "overflow",
    );
  });

  it("an empty factor list is the product one", () => {
    expect(mulDivWide([], [], "down")).toBe(1n);
    expect(mulDivWide([], [2n], "up")).toBe(1n);
    expect(mulDivWide([], [2n], "down")).toBe(0n);
  });

  it("remainder matches its definition", () => {
    expect(mulDivRem(10n, 7n, 4n)).toEqual({ quotient: 17n, remainder: 2n });
    expect(mulDivRem(U128_MAX, 2n, U128_MAX)).toEqual({ quotient: 2n, remainder: 0n });
  });

  it("powers of ten", () => {
    expect(pow10(0)).toBe(1n);
    expect(pow10(6)).toBe(1_000_000n);
    expect(pow10(18)).toBe(ONE);
    expect(pow10(38)).toBe(10n ** 38n);
  });

  it("rejects values outside the integer domains", () => {
    const u128 = (value: bigint) => () => {
      assertU128(value, "x");
    };
    const u64 = (value: bigint) => () => {
      assertU64(value, "x");
    };
    const u8 = (value: number) => () => {
      assertU8(value, "x");
    };
    expect(u128(-1n)).toThrow(RangeError);
    expect(u128(U128_MAX + 1n)).toThrow(RangeError);
    expect(u128(U128_MAX)).not.toThrow();
    expect(u64(U64_MAX + 1n)).toThrow(RangeError);
    expect(u64(0n)).not.toThrow();
    expect(u8(256)).toThrow(RangeError);
    expect(u8(1.5)).toThrow(RangeError);
    expect(u8(255)).not.toThrow();
    expect(() => mulDivFloor(-1n, 1n, 1n)).toThrow(RangeError);
    expect(() => mulDivWide([1n, -1n], [1n], "down")).toThrow(RangeError);
    expect(() => pow10(256)).toThrow(RangeError);
  });
});
