/**
 * Unlock schedules of deposited positions and of position classes: a port of
 * `contracts/engine/src/unlock.rs`.
 *
 * Two layers live here:
 *
 * - Exact ports of the foreign protocols' vesting math, per position: {@link SablierLinearStream}
 *   (Sablier Lockup v4, Lockup Linear model) and {@link StreamflowStream} (Streamflow on Solana).
 *   They return token base units, exactly as the foreign contract would.
 * - The class schedule ({@link ClassSchedule}): the normalized schedule shared by every position of
 *   a class, which defines the unlock function `f(t)` in `[0, ONE]` used for accrual accounting.
 *
 * Timestamps are Unix seconds. Rounding always favors the pool: for every position `p` of a class
 * with allocation `D_p` and every time `t`, `D_p * f(t) / ONE <= streamed_p(t)`.
 *
 * @module
 */

import { assertU128, assertU64, MathError, mulDivFloor, mulDivWide, ONE, pow10 } from "./math.js";

/** Unix timestamp in seconds (`u64`). */
export type Timestamp = bigint;

/** Reason a schedule is refused, one per `ScheduleError` variant of the engine. */
export type ScheduleErrorCode =
  | "zero_deposit"
  | "zero_start_time"
  | "start_not_before_cliff"
  | "cliff_not_before_end"
  | "start_not_before_end"
  | "cliff_unlock_without_cliff"
  | "zero_granularity"
  | "granularity_too_high"
  | "unlock_amounts_exceed_deposit"
  | "zero_period"
  | "cliff_amount_exceeds_deposit"
  | "end_before_start"
  | "deposit_below_minimum"
  | "token_decimals_too_large";

const SCHEDULE_ERROR_MESSAGES: Readonly<Record<ScheduleErrorCode, string>> = {
  zero_deposit: "deposited amount is zero",
  zero_start_time: "start time is zero",
  start_not_before_cliff: "start time is not before the cliff time",
  cliff_not_before_end: "cliff time is not before the end time",
  start_not_before_end: "start time is not before the end time",
  cliff_unlock_without_cliff: "cliff unlock amount without a cliff time",
  zero_granularity: "unlock granularity is zero",
  granularity_too_high: "unlock granularity exceeds the streamable range",
  unlock_amounts_exceed_deposit: "unlock amounts exceed the deposited amount",
  zero_period: "unlock period is zero",
  cliff_amount_exceeds_deposit: "cliff amount exceeds the deposited amount",
  end_before_start: "end time is before the start time",
  deposit_below_minimum: "position is smaller than one whole token",
  token_decimals_too_large: "token decimals are too large",
};

/** A schedule the engine refuses. */
export class ScheduleError extends Error {
  /** The refusal code. */
  readonly code: ScheduleErrorCode;

  /** @param code - The refusal code. */
  constructor(code: ScheduleErrorCode) {
    super(SCHEDULE_ERROR_MESSAGES[code]);
    this.name = "ScheduleError";
    this.code = code;
  }
}

/**
 * Raw parameters of a Sablier Lockup v4 Lockup Linear stream, as read from the contract
 * (`getStartTime`, `getCliffTime`, `getEndTime`, `getGranularity`, `getUnlockAmounts`,
 * `getDepositedAmount`).
 */
export interface SablierLinearParams {
  /** Start time. */
  readonly start: Timestamp;
  /** Cliff time, `0n` when the stream has no cliff. */
  readonly cliff: Timestamp;
  /** End time. */
  readonly end: Timestamp;
  /** Unlock granularity in seconds (Sablier stores at least `1`). */
  readonly granularity: bigint;
  /** Amount unlocked at the start time. */
  readonly startUnlock: bigint;
  /** Amount unlocked at the cliff time. */
  readonly cliffUnlock: bigint;
  /** Deposited amount. */
  readonly deposited: bigint;
}

/**
 * A validated Sablier Lockup v4 Lockup Linear stream.
 *
 * {@link SablierLinearStream.streamedAmount} ports `LockupMath.calculateStreamedAmountLL` of
 * `sablier-labs/evm-monorepo` at tag `lockup@v4.0.1`, through the engine's own port. Lockup v4
 * uses plain integer arithmetic for this model: the streamed portion is
 * `floor(floor(elapsed / granularity) * streamable * granularity / streamableDuration)`.
 *
 * Validation mirrors Sablier's creation checks, so every stream Sablier can create is accepted.
 */
export class SablierLinearStream {
  /** The validated parameters. */
  readonly params: SablierLinearParams;

  /**
   * Validates raw stream parameters with Sablier's own creation rules.
   *
   * @throws {ScheduleError} When Sablier would refuse to create the stream.
   * @throws {RangeError} When a parameter is outside its integer domain.
   */
  constructor(params: SablierLinearParams) {
    assertU64(params.start, "start");
    assertU64(params.cliff, "cliff");
    assertU64(params.end, "end");
    assertU64(params.granularity, "granularity");
    assertU128(params.startUnlock, "startUnlock");
    assertU128(params.cliffUnlock, "cliffUnlock");
    assertU128(params.deposited, "deposited");
    if (params.deposited === 0n) {
      throw new ScheduleError("zero_deposit");
    }
    if (params.start === 0n) {
      throw new ScheduleError("zero_start_time");
    }
    let streamableRange: bigint;
    if (params.cliff > 0n) {
      if (params.start >= params.cliff) {
        throw new ScheduleError("start_not_before_cliff");
      }
      if (params.cliff >= params.end) {
        throw new ScheduleError("cliff_not_before_end");
      }
      streamableRange = params.end - params.cliff;
    } else {
      if (params.cliffUnlock > 0n) {
        throw new ScheduleError("cliff_unlock_without_cliff");
      }
      if (params.start >= params.end) {
        throw new ScheduleError("start_not_before_end");
      }
      streamableRange = params.end - params.start;
    }
    if (params.granularity === 0n) {
      throw new ScheduleError("zero_granularity");
    }
    if (params.granularity > streamableRange) {
      throw new ScheduleError("granularity_too_high");
    }
    if (params.startUnlock + params.cliffUnlock > params.deposited) {
      throw new ScheduleError("unlock_amounts_exceed_deposit");
    }
    this.params = { ...params };
  }

  /**
   * Amount streamed (unlocked) at time `t`, in token base units, exactly as Sablier computes it.
   *
   * @throws {RangeError} When `t` is not a `u64`.
   */
  streamedAmount(t: Timestamp): bigint {
    assertU64(t, "t");
    const p = this.params;
    if (p.start > t) {
      return 0n;
    }
    if (p.cliff > t) {
      return p.startUnlock;
    }
    if (p.end <= t) {
      return p.deposited;
    }
    const unlockAmountsSum = p.startUnlock + p.cliffUnlock;
    if (unlockAmountsSum >= p.deposited) {
      return p.deposited;
    }
    const base = p.cliff === 0n ? p.start : p.cliff;
    const elapsedUnits = (t - base) / p.granularity;
    const streamableTotalDuration = p.end - base;
    const streamableAmount = p.deposited - unlockAmountsSum;
    // `elapsedUnits * granularity <= t - base < streamableTotalDuration`, so the portion is below
    // `streamableAmount` and the division cannot fail.
    const streamedPortion = mulDivWide(
      [elapsedUnits, streamableAmount, p.granularity],
      [streamableTotalDuration],
      "down",
    );
    return unlockAmountsSum + streamedPortion;
  }
}

/** Raw parameters of a Streamflow stream, as read from its metadata account. */
export interface StreamflowParams {
  /** `ix.start_time`. */
  readonly startTime: Timestamp;
  /** `ix.cliff`, `0n` when unset. */
  readonly cliff: Timestamp;
  /** `ix.cliff_amount` (`u64`). */
  readonly cliffAmount: bigint;
  /** `ix.period` in seconds. */
  readonly period: bigint;
  /** `ix.amount_per_period` (`u64`). */
  readonly amountPerPeriod: bigint;
  /** `ix.net_amount_deposited` (`u64`). */
  readonly netAmountDeposited: bigint;
  /** `end_time`, computed by the program at creation and stored in the account. */
  readonly endTime: Timestamp;
}

/**
 * A validated Streamflow stream (stepped unlock).
 *
 * {@link StreamflowStream.unlockedAmount} ports `Contract::available_to_claim` and its helpers of
 * `streamflow-finance/rust-sdk` (commit `63df7d7b`), through the engine's own port, for a stream
 * that was never paused and whose rate was never updated (the engine refuses pausable,
 * rate-updatable and top-up streams):
 *
 * - `start = cliff` when `cliff > 0`, else `startTime`;
 * - `t < start`: `0`;
 * - `t >= endTime`: `netAmountDeposited`;
 * - otherwise `min(cliffAmount + floor((t - start) / period) * amountPerPeriod,
 *   netAmountDeposited)`.
 */
export class StreamflowStream {
  /** The validated parameters. */
  readonly params: StreamflowParams;

  /**
   * Validates raw stream parameters.
   *
   * @throws {ScheduleError} When the engine refuses the stream.
   * @throws {RangeError} When a parameter is outside its integer domain.
   */
  constructor(params: StreamflowParams) {
    assertU64(params.startTime, "startTime");
    assertU64(params.cliff, "cliff");
    assertU64(params.cliffAmount, "cliffAmount");
    assertU64(params.period, "period");
    assertU64(params.amountPerPeriod, "amountPerPeriod");
    assertU64(params.netAmountDeposited, "netAmountDeposited");
    assertU64(params.endTime, "endTime");
    if (params.netAmountDeposited === 0n) {
      throw new ScheduleError("zero_deposit");
    }
    if (params.period === 0n) {
      throw new ScheduleError("zero_period");
    }
    if (params.cliffAmount > params.netAmountDeposited) {
      throw new ScheduleError("cliff_amount_exceeds_deposit");
    }
    this.params = { ...params };
    if (params.endTime < this.effectiveStart()) {
      throw new ScheduleError("end_before_start");
    }
  }

  /** The only start the program's math reads: the cliff when set, else the start time. */
  effectiveStart(): Timestamp {
    return this.params.cliff > 0n ? this.params.cliff : this.params.startTime;
  }

  /**
   * Amount unlocked at time `t`, in token base units.
   *
   * @throws {RangeError} When `t` is not a `u64`.
   */
  unlockedAmount(t: Timestamp): bigint {
    assertU64(t, "t");
    const p = this.params;
    const start = this.effectiveStart();
    if (t < start) {
      return 0n;
    }
    if (t >= p.endTime) {
      return p.netAmountDeposited;
    }
    const periods = (t - start) / p.period;
    const vested = periods * p.amountPerPeriod + p.cliffAmount;
    return vested < p.netAmountDeposited ? vested : p.netAmountDeposited;
  }
}

/**
 * Normalized schedule of a class of Sablier LL streams.
 *
 * Sablier floors the streamed portion per stream, and that floor does not scale: two streams
 * with exactly proportional amounts can differ by up to one base unit, so `floor(streamed * ONE /
 * deposited)` of one member can exceed the true fraction of another member. The class therefore
 * uses the exact linear fraction lowered by a margin of `ceil(ONE / minDeposit)`:
 *
 * ```text
 * f(t) = 0                                          t < start
 *      = floor(ONE * startUnlock / total)            start <= t < cliff
 *      = ONE                                        t >= end
 *      = max(u0, u0 + floor(ONE * n * g * a / (d * total)) - margin)   otherwise
 * ```
 *
 * where `u0 = floor(ONE * (startUnlock + cliffUnlock) / total)`, `a = total - startUnlock -
 * cliffUnlock`, `g` the granularity, `n = floor((t - b) / g)`, `b` the cliff (or the start when
 * there is no cliff) and `d = end - b`. With `minDeposit` one whole token, the margin is at most
 * one base unit per whole token held.
 *
 * Two streams are in the same class exactly when every field of their `LinearClass` is equal.
 */
export class LinearClass {
  /** Discriminant of {@link ClassSchedule}. */
  readonly kind = "linear";
  /** Start time. */
  readonly start: Timestamp;
  /** Cliff time, `0n` when there is no cliff. */
  readonly cliff: Timestamp;
  /** End time. */
  readonly end: Timestamp;
  /** Unlock granularity in seconds. */
  readonly granularity: bigint;
  /** Reduced start unlock amount. */
  readonly startUnlock: bigint;
  /** Reduced cliff unlock amount. */
  readonly cliffUnlock: bigint;
  /** Reduced total. */
  readonly total: bigint;
  /** Smallest deposit accepted in the class (one whole token). */
  readonly minDeposit: bigint;

  private constructor(fields: {
    start: Timestamp;
    cliff: Timestamp;
    end: Timestamp;
    granularity: bigint;
    startUnlock: bigint;
    cliffUnlock: bigint;
    total: bigint;
    minDeposit: bigint;
  }) {
    this.start = fields.start;
    this.cliff = fields.cliff;
    this.end = fields.end;
    this.granularity = fields.granularity;
    this.startUnlock = fields.startUnlock;
    this.cliffUnlock = fields.cliffUnlock;
    this.total = fields.total;
    this.minDeposit = fields.minDeposit;
  }

  /**
   * The class schedule of a Sablier LL stream of a token with `tokenDecimals` decimals.
   *
   * Normalization keeps the timestamps and the granularity, and divides `(deposited, startUnlock,
   * cliffUnlock)` by their greatest common divisor. Streams smaller than one whole token are
   * refused.
   *
   * @throws {ScheduleError} `deposit_below_minimum` or `token_decimals_too_large`.
   * @throws {RangeError} When `tokenDecimals` is not a `u8`.
   */
  static fromStream(stream: SablierLinearStream, tokenDecimals: number): LinearClass {
    const p = stream.params;
    const minDeposit = minDepositOf(tokenDecimals);
    if (p.deposited < minDeposit) {
      throw new ScheduleError("deposit_below_minimum");
    }
    const divisor = gcd(gcd(p.deposited, p.startUnlock), p.cliffUnlock);
    return new LinearClass({
      start: p.start,
      cliff: p.cliff,
      end: p.end,
      granularity: p.granularity,
      startUnlock: p.startUnlock / divisor,
      cliffUnlock: p.cliffUnlock / divisor,
      total: p.deposited / divisor,
      minDeposit,
    });
  }

  /** Margin subtracted from the linear segment, `ceil(ONE / minDeposit)`. */
  margin(): bigint {
    return (ONE + this.minDeposit - 1n) / this.minDeposit;
  }

  /**
   * Unlocked fraction `f(t)` in `[0, ONE]`.
   *
   * @throws {RangeError} When `t` is not a `u64`.
   */
  fraction(t: Timestamp): bigint {
    assertU64(t, "t");
    if (this.start > t) {
      return 0n;
    }
    if (this.cliff > t) {
      return portion(ONE, this.startUnlock, this.total);
    }
    if (this.end <= t) {
      return ONE;
    }
    const unlocked = this.startUnlock + this.cliffUnlock;
    const atCliff = portion(ONE, unlocked, this.total);
    const base = this.cliff === 0n ? this.start : this.cliff;
    const elapsed = ((t - base) / this.granularity) * this.granularity;
    // `elapsed < end - base` and `total - unlocked <= total`, so the result is below `ONE` and
    // the division cannot fail.
    const streamed = mulDivWide(
      [ONE, elapsed, this.total - unlocked],
      [this.end - base, this.total],
      "down",
    );
    const raised = atCliff + streamed;
    const margin = this.margin();
    const lowered = raised > margin ? raised - margin : 0n;
    return lowered > atCliff ? lowered : atCliff;
  }
}

/**
 * Normalized schedule of a class of Streamflow streams.
 *
 * Streamflow's unlocked amount is an exact multiple of the reduced schedule (`min` of two
 * multiples, no rounding), so `f(t) = floor(ONE * unlocked(t) / netAmountDeposited)` is the same
 * for every member and needs no margin.
 *
 * Two streams are in the same class exactly when every field of their `SteppedClass` is equal.
 */
export class SteppedClass {
  /** Discriminant of {@link ClassSchedule}. */
  readonly kind = "stepped";
  /** Effective start (the cliff when set, else the start time). */
  readonly start: Timestamp;
  /** End time. */
  readonly end: Timestamp;
  /** Period in seconds. */
  readonly period: bigint;
  /** Reduced cliff amount. */
  readonly cliffAmount: bigint;
  /** Reduced amount per period. */
  readonly amountPerPeriod: bigint;
  /** Reduced total. */
  readonly total: bigint;

  private constructor(fields: {
    start: Timestamp;
    end: Timestamp;
    period: bigint;
    cliffAmount: bigint;
    amountPerPeriod: bigint;
    total: bigint;
  }) {
    this.start = fields.start;
    this.end = fields.end;
    this.period = fields.period;
    this.cliffAmount = fields.cliffAmount;
    this.amountPerPeriod = fields.amountPerPeriod;
    this.total = fields.total;
  }

  /**
   * The class schedule of a Streamflow stream: the effective start, `endTime` and `period` are
   * kept; `(netAmountDeposited, cliffAmount, amountPerPeriod)` are divided by their gcd.
   */
  static fromStream(stream: StreamflowStream): SteppedClass {
    const p = stream.params;
    const divisor = gcd(gcd(p.netAmountDeposited, p.cliffAmount), p.amountPerPeriod);
    return new SteppedClass({
      start: stream.effectiveStart(),
      end: p.endTime,
      period: p.period,
      cliffAmount: p.cliffAmount / divisor,
      amountPerPeriod: p.amountPerPeriod / divisor,
      total: p.netAmountDeposited / divisor,
    });
  }

  /**
   * Unlocked fraction `f(t)` in `[0, ONE]`.
   *
   * @throws {RangeError} When `t` is not a `u64`.
   */
  fraction(t: Timestamp): bigint {
    assertU64(t, "t");
    if (t < this.start) {
      return 0n;
    }
    if (t >= this.end) {
      return ONE;
    }
    const periods = (t - this.start) / this.period;
    const vested = periods * this.amountPerPeriod + this.cliffAmount;
    const unlocked = vested < this.total ? vested : this.total;
    return portion(ONE, unlocked, this.total);
  }
}

/**
 * Normalized schedule of a class: the schedule part of the class key and its unlock function
 * `f(t)`, non-decreasing in `t`, `0` before the start (the start unlock excepted), `ONE` at and
 * after the end, and never above the exact unlocked fraction of any position of the class.
 */
export type ClassSchedule = LinearClass | SteppedClass;

/**
 * Tokens accrued by `balance` units while the class fraction moves from `from` to `to`:
 * `floor(balance * (to - from) / ONE)`. Returns `0n` when `to <= from`.
 *
 * @throws {RangeError} When an argument is not a `u128`.
 */
export function accrual(balance: bigint, from: bigint, to: bigint): bigint {
  assertU128(balance, "balance");
  assertU128(from, "from");
  assertU128(to, "to");
  return portion(balance, to > from ? to - from : 0n, ONE);
}

function minDepositOf(tokenDecimals: number): bigint {
  try {
    return pow10(tokenDecimals);
  } catch (error) {
    if (error instanceof MathError) {
      throw new ScheduleError("token_decimals_too_large");
    }
    throw error;
  }
}

/**
 * `floor(value * numerator / denominator)` for `numerator <= denominator`: the result never
 * exceeds `value`. Every caller passes a non-zero denominator (class totals are at least `1`,
 * accrual divides by `ONE`).
 */
function portion(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return mulDivFloor(value, numerator < denominator ? numerator : denominator, denominator);
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}
