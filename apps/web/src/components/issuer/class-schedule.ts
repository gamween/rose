/**
 * Class creation helpers: the schedule as the issuer types it or as a stream carries it, its
 * normalization (the same gcd reduction the engine applies in `ensure_class`) and the view
 * arguments of `compute_base_class_id` / `compute_sol_class_id`.
 */

import {
  LinearClass,
  SablierLinearStream,
  SteppedClass,
  StreamflowStream,
  type SablierScheduleArgs,
  type SablierStream,
  type StreamflowMetadata,
  type StreamflowScheduleArgs,
} from "@rose/sdk";
import type { EngineSchedule } from "@/lib/unlock-schedule";

export type LinearInput = { start: bigint; cliff: bigint; end: bigint; granularity: bigint; deposited: bigint; startUnlock: bigint; cliffUnlock: bigint };

export type SteppedInput = { startTime: bigint; cliff: bigint; endTime: bigint; period: bigint; netAmountDeposited: bigint; cliffAmount: bigint; amountPerPeriod: bigint };

/** The normalized Linear schedule of a Sablier stream (throws `ScheduleError` when Sablier itself would refuse it). */
export function normalizeLinear(input: LinearInput, decimals: number): EngineSchedule {
  const cls = LinearClass.fromStream(new SablierLinearStream(input), decimals);
  return { kind: "Linear", start: cls.start, cliff: cls.cliff, end: cls.end, granularity: cls.granularity, total: cls.total, startUnlock: cls.startUnlock, cliffUnlock: cls.cliffUnlock, minDeposit: cls.minDeposit };
}

/** The normalized Stepped schedule of a Streamflow stream. */
export function normalizeStepped(input: SteppedInput): EngineSchedule {
  const cls = SteppedClass.fromStream(new StreamflowStream(input));
  return { kind: "Stepped", start: cls.start, end: cls.end, period: cls.period, amountPerPeriod: cls.amountPerPeriod, cliffAmount: cls.cliffAmount, total: cls.total };
}

function u64Number(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${field} (${value.toString()}) does not fit a JSON number; the class id view takes u64 numbers.`);
  return Number(value);
}

/** A `u64` token amount as the `U64` JSON string the engine takes (Solana amounts exceed 2^53). */
function u64String(value: bigint, field: string): string {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError(`${field} (${value.toString()}) is not a u64.`);
  return value.toString();
}

/** `compute_base_class_id` arguments from the raw stream parameters. */
export function sablierScheduleArgs(input: LinearInput): SablierScheduleArgs {
  return {
    start: u64Number(input.start, "start"),
    cliff: u64Number(input.cliff, "cliff"),
    end: u64Number(input.end, "end"),
    granularity: u64Number(input.granularity, "granularity"),
    deposited: input.deposited.toString(),
    start_unlock: input.startUnlock.toString(),
    cliff_unlock: input.cliffUnlock.toString(),
  };
}

/** `compute_sol_class_id` arguments from the raw stream parameters: times as `u64` numbers, token amounts as `U64` strings. */
export function streamflowScheduleArgs(input: SteppedInput): StreamflowScheduleArgs {
  return {
    start_time: u64Number(input.startTime, "start_time"),
    end_time: u64Number(input.endTime, "end_time"),
    net_amount_deposited: u64String(input.netAmountDeposited, "net_amount_deposited"),
    period: u64Number(input.period, "period"),
    amount_per_period: u64String(input.amountPerPeriod, "amount_per_period"),
    cliff: u64Number(input.cliff, "cliff"),
    cliff_amount: u64String(input.cliffAmount, "cliff_amount"),
  };
}

export function linearInputOfStream(stream: SablierStream): LinearInput {
  return {
    start: BigInt(stream.start),
    cliff: BigInt(stream.cliff),
    end: BigInt(stream.end),
    granularity: BigInt(stream.granularity),
    deposited: stream.deposited,
    startUnlock: stream.unlockAmounts.start,
    cliffUnlock: stream.unlockAmounts.cliff,
  };
}

export function steppedInputOfMetadata(metadata: StreamflowMetadata): SteppedInput {
  return {
    startTime: metadata.startTime,
    cliff: metadata.cliff,
    endTime: metadata.endTime,
    period: metadata.period,
    netAmountDeposited: metadata.netAmountDeposited,
    cliffAmount: metadata.cliffAmount,
    amountPerPeriod: metadata.amountPerPeriod,
  };
}

/** `datetime-local` text (interpreted as UTC) to unix seconds; null when empty or invalid. */
export function dateTimeToSeconds(text: string): bigint | null {
  if (!text) return null;
  const ms = Date.parse(text.length === 16 ? `${text}:00Z` : `${text}Z`);
  return Number.isNaN(ms) ? null : BigInt(Math.floor(ms / 1000));
}

/** Unix seconds to the `datetime-local` text (UTC, minute precision). */
export function secondsToDateTime(seconds: bigint | number): string {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 16);
}
