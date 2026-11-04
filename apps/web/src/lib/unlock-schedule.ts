/**
 * The unlock function of a class as the app reads it (`ClassInfo.schedule`, already normalized by
 * the engine), rebuilt with the `@rose/sdk` math so the browser computes exactly what the
 * contract computes: locked and claimable amounts to now, and the timeline of `f(t)`.
 */

import { LinearClass, ONE, SablierLinearStream, SteppedClass, StreamflowStream, type ClassInfo } from "@rose/sdk";

/** The normalized schedule as `get_class` returns it (the `ClassSchedule` of `@rose/sdk`'s engine types). */
export type EngineSchedule = ClassInfo["schedule"];

export type UnlockFunction = LinearClass | SteppedClass;

/**
 * Rebuilds the class unlock function from the normalized schedule. `LinearClass.fromStream`
 * refuses streams below one whole token, and the normalized amounts are reduced by their gcd,
 * so they are scaled back up by a common factor first: `f(t)` only depends on the ratios and on
 * the class minimum deposit, so the scaling changes nothing.
 */
export function unlockFunctionOf(schedule: EngineSchedule, decimals: number): UnlockFunction {
  if (schedule.kind === "Linear") {
    const minDeposit = 10n ** BigInt(decimals);
    const factor = schedule.total >= minDeposit ? 1n : (minDeposit + schedule.total - 1n) / schedule.total;
    const stream = new SablierLinearStream({
      start: schedule.start,
      cliff: schedule.cliff,
      end: schedule.end,
      granularity: schedule.granularity,
      startUnlock: schedule.startUnlock * factor,
      cliffUnlock: schedule.cliffUnlock * factor,
      deposited: schedule.total * factor,
    });
    return LinearClass.fromStream(stream, decimals);
  }
  const stream = new StreamflowStream({
    startTime: schedule.start,
    cliff: 0n,
    cliffAmount: schedule.cliffAmount,
    period: schedule.period,
    amountPerPeriod: schedule.amountPerPeriod,
    netAmountDeposited: schedule.total,
    endTime: schedule.end,
  });
  return SteppedClass.fromStream(stream);
}

/** `f(t)` of a class at `t` (unix seconds), 1e18 fixed point. */
export function fractionAt(info: Pick<ClassInfo, "schedule" | "decimals">, t: bigint): bigint {
  return unlockFunctionOf(info.schedule, info.decimals).fraction(t);
}

/** First and last timestamps (seconds) of the schedule, and the cliff when there is one. */
export function scheduleBounds(schedule: EngineSchedule): { start: bigint; cliff: bigint | null; end: bigint } {
  if (schedule.kind === "Linear") return { start: schedule.start, cliff: schedule.cliff > 0n ? schedule.cliff : null, end: schedule.end };
  return { start: schedule.start, cliff: null, end: schedule.end };
}

export type TimelinePoint = { t: number; fraction: number };

/**
 * Samples `f(t)` across the schedule for a chart: `samples` evenly spaced points plus the exact
 * breakpoints (start, cliff, end), each evaluated with the contract math. Stepped schedules
 * also get the instants just before and at every period boundary they can afford so the steps
 * render as steps rather than slopes.
 */
export function timelinePoints(info: Pick<ClassInfo, "schedule" | "decimals">, samples = 160): TimelinePoint[] {
  const f = unlockFunctionOf(info.schedule, info.decimals);
  const { start, cliff, end } = scheduleBounds(info.schedule);
  const span = end - start;
  const times = new Set<bigint>([start > 0n ? start - 1n : 0n, start, end, end + 1n]);
  if (cliff !== null) {
    times.add(cliff - 1n);
    times.add(cliff);
  }
  if (span > 0n) {
    for (let i = 1; i < samples; i += 1) times.add(start + (span * BigInt(i)) / BigInt(samples));
    if (info.schedule.kind === "Stepped" && info.schedule.period > 0n) {
      const periods = span / info.schedule.period;
      if (periods <= BigInt(samples)) {
        for (let i = 1n; i <= periods; i += 1n) {
          const boundary = start + i * info.schedule.period;
          times.add(boundary - 1n);
          times.add(boundary);
        }
      }
    }
  }
  return [...times]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((t) => ({ t: Number(t), fraction: Number((f.fraction(t) * 1_000_000n) / ONE) / 1_000_000 }));
}
