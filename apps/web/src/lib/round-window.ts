/**
 * The creation bounds of a round's durations (spec 5.6, `get_limits`): `closes_at` at most
 * `max_round_horizon` after creation, `key_timeout` and `reveal_window` within their minimum and
 * maximum. The forms check them inline with the same rule the engine applies, so a round that
 * would be refused is never signed. Durations are entered in whole minutes (every bound is one).
 */

import type { ConfigView, Limits } from "@rose/sdk";

export type WindowBounds = Pick<Limits, "minKeyTimeout" | "maxKeyTimeout" | "minRevealWindow" | "maxRevealWindow" | "maxRoundHorizon">;

const NS_PER_MINUTE = 60_000_000_000n;
const NS_PER_SECOND = 1_000_000_000n;

/** Whole minutes typed in a field, in nanoseconds; null when empty or not a whole number. */
export function minutesToNs(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed) * NS_PER_MINUTE;
}

/** A nanosecond duration as the minutes text of a field (the engine defaults are whole minutes). */
export function nsToMinutesText(ns: bigint): string {
  return (ns / NS_PER_MINUTE).toString();
}

/** `30 d`, `7 d`, `1 h`, `5 min`, `90 s`: the largest whole unit of a bound. */
export function formatBound(ns: bigint): string {
  const seconds = ns / NS_PER_SECOND;
  if (seconds > 0n && seconds % 86_400n === 0n) return `${(seconds / 86_400n).toString()} d`;
  if (seconds > 0n && seconds % 3_600n === 0n) return `${(seconds / 3_600n).toString()} h`;
  if (seconds > 0n && seconds % 60n === 0n) return `${(seconds / 60n).toString()} min`;
  return `${seconds.toString()} s`;
}

function boundedError(label: string, value: bigint | null, min: bigint, max: bigint): string | null {
  if (value === null) return `Enter the ${label} in whole minutes.`;
  if (value < min) return `The ${label} must be at least ${formatBound(min)}.`;
  if (value > max) return `The ${label} must be at most ${formatBound(max)}.`;
  return null;
}

/** Inline errors of the key timeout and reveal window fields. */
export function durationErrors(input: { keyTimeout: bigint | null; revealWindow: bigint | null }, limits: WindowBounds): { keyTimeout: string | null; revealWindow: string | null } {
  return {
    keyTimeout: boundedError("key timeout", input.keyTimeout, limits.minKeyTimeout, limits.maxKeyTimeout),
    revealWindow: boundedError("reveal window", input.revealWindow, limits.minRevealWindow, limits.maxRevealWindow),
  };
}

/** The latest `closes_at` a round created at `nowNs` can have. */
export function latestCloseNs(nowNs: bigint, limits: WindowBounds): bigint {
  return nowNs + limits.maxRoundHorizon;
}

/**
 * The horizon error of a close time, or null. The engine measures it from the block that
 * creates the round, which comes after `nowNs`, so a close accepted here is accepted there.
 */
export function horizonError(closesAtNs: bigint, nowNs: bigint, limits: WindowBounds): string | null {
  return closesAtNs > latestCloseNs(nowNs, limits) ? `A round closes at most ${formatBound(limits.maxRoundHorizon)} after it is created: pick an earlier close.` : null;
}

/** One hint line: the allowed range of each duration. */
export function boundsHint(limits: WindowBounds): string {
  return `Key timeout ${formatBound(limits.minKeyTimeout)} to ${formatBound(limits.maxKeyTimeout)}; reveal window ${formatBound(limits.minRevealWindow)} to ${formatBound(limits.maxRevealWindow)}.`;
}

/** The engine defaults as field texts. */
export function defaultDurations(config: Pick<ConfigView, "default_key_timeout" | "default_reveal_window">): { keyTimeout: string; revealWindow: string } {
  return { keyTimeout: nsToMinutesText(BigInt(config.default_key_timeout)), revealWindow: nsToMinutesText(BigInt(config.default_reveal_window)) };
}
