/**
 * Checked integer arithmetic for settlement amounts: a port of `contracts/engine/src/math.rs`.
 *
 * Every value is a `bigint` constrained to the Rust integer domain (`u128`, `u64`). JavaScript
 * bigints never overflow, so the Rust overflow conditions are reproduced explicitly: a result that
 * does not fit in 128 bits, or an intermediate product that does not fit in the 256 or 512-bit
 * wide integer the engine uses, throws {@link MathError} exactly where the engine returns one.
 *
 * @module
 */

/** Fixed-point one: fractions are stored as integers scaled by `1e18`. */
export const ONE = 10n ** 18n;

/** Largest `u128`. */
export const U128_MAX = (1n << 128n) - 1n;

/** Largest `u64`. */
export const U64_MAX = (1n << 64n) - 1n;

/** Largest `u8`. */
export const U8_MAX = 255;

const U512_MAX = (1n << 512n) - 1n;

/** Rounding direction of a division. */
export type Rounding = "down" | "up";

/** Arithmetic failure code, one per `MathError` variant of the engine. */
export type MathErrorCode = "division_by_zero" | "overflow";

/** Arithmetic failure. The engine returns these; the SDK throws them. */
export class MathError extends Error {
  /** The failure code. */
  readonly code: MathErrorCode;

  /** @param code - The failure code. */
  constructor(code: MathErrorCode) {
    super(code === "division_by_zero" ? "division by zero" : "arithmetic overflow");
    this.name = "MathError";
    this.code = code;
  }
}

/**
 * Checks that `value` is a `u128`.
 *
 * @param value - The value to check.
 * @param label - Name of the value, used in the error message.
 * @throws {RangeError} When `value` is negative or above {@link U128_MAX}.
 */
export function assertU128(value: bigint, label: string): void {
  if (value < 0n || value > U128_MAX) {
    throw new RangeError(`${label} must be a u128`);
  }
}

/**
 * Checks that `value` is a `u64`.
 *
 * @param value - The value to check.
 * @param label - Name of the value, used in the error message.
 * @throws {RangeError} When `value` is negative or above {@link U64_MAX}.
 */
export function assertU64(value: bigint, label: string): void {
  if (value < 0n || value > U64_MAX) {
    throw new RangeError(`${label} must be a u64`);
  }
}

/**
 * Checks that `value` is a `u8` (an integer in `[0, 255]`).
 *
 * @param value - The value to check.
 * @param label - Name of the value, used in the error message.
 * @throws {RangeError} When `value` is not an integer in `[0, 255]`.
 */
export function assertU8(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > U8_MAX) {
    throw new RangeError(`${label} must be a u8`);
  }
}

/**
 * `a * b / c` rounded in the given direction, with a 256-bit intermediate.
 *
 * @throws {MathError} `division_by_zero` when `c` is zero, `overflow` when the result does not
 * fit in 128 bits.
 */
export function mulDiv(a: bigint, b: bigint, c: bigint, rounding: Rounding): bigint {
  assertU128(a, "a");
  assertU128(b, "b");
  assertU128(c, "c");
  if (c === 0n) {
    throw new MathError("division_by_zero");
  }
  const product = a * b;
  const quotient = product / c;
  return toU128(rounding === "up" && product % c !== 0n ? quotient + 1n : quotient);
}

/**
 * `floor(a * b / c)` with a 256-bit intermediate.
 *
 * @throws {MathError} See {@link mulDiv}.
 */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  return mulDiv(a, b, c, "down");
}

/**
 * `ceil(a * b / c)` with a 256-bit intermediate.
 *
 * @throws {MathError} See {@link mulDiv}.
 */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  return mulDiv(a, b, c, "up");
}

/** Quotient and remainder of a {@link mulDivRem}. */
export interface QuotientRemainder {
  /** `floor(a * b / c)`. */
  readonly quotient: bigint;
  /** `(a * b) mod c`. */
  readonly remainder: bigint;
}

/**
 * `(floor(a * b / c), (a * b) mod c)` with a 256-bit intermediate.
 *
 * @throws {MathError} `division_by_zero` when `c` is zero, `overflow` when the quotient does not
 * fit in 128 bits.
 */
export function mulDivRem(a: bigint, b: bigint, c: bigint): QuotientRemainder {
  assertU128(a, "a");
  assertU128(b, "b");
  assertU128(c, "c");
  if (c === 0n) {
    throw new MathError("division_by_zero");
  }
  const product = a * b;
  return { quotient: toU128(product / c), remainder: product % c };
}

/**
 * `product(factors) / product(divisors)` rounded in the given direction, with a 512-bit
 * intermediate. Up to three full-width factors always fit; an empty list is the product `1`.
 *
 * @throws {MathError} `overflow` when a product does not fit in 512 bits or the result does not
 * fit in 128 bits, `division_by_zero` when the divisors multiply to zero.
 */
export function mulDivWide(
  factors: readonly bigint[],
  divisors: readonly bigint[],
  rounding: Rounding,
): bigint {
  const numerator = product(factors, "factor");
  const denominator = product(divisors, "divisor");
  if (denominator === 0n) {
    throw new MathError("division_by_zero");
  }
  const quotient = numerator / denominator;
  return toU128(rounding === "up" && numerator % denominator !== 0n ? quotient + 1n : quotient);
}

/**
 * `10^exponent`, checked.
 *
 * @throws {MathError} `overflow` when the power does not fit in 128 bits (`exponent > 38`).
 */
export function pow10(exponent: number): bigint {
  assertU8(exponent, "exponent");
  if (exponent > 38) {
    throw new MathError("overflow");
  }
  return 10n ** BigInt(exponent);
}

function product(values: readonly bigint[], label: string): bigint {
  let accumulator = 1n;
  for (const value of values) {
    assertU128(value, label);
    accumulator *= value;
    if (accumulator > U512_MAX) {
      throw new MathError("overflow");
    }
  }
  return accumulator;
}

function toU128(value: bigint): bigint {
  if (value > U128_MAX) {
    throw new MathError("overflow");
  }
  return value;
}
