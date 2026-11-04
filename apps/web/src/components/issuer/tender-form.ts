/**
 * Launch Tender math and validation (spec 5.4, 5.5, 5.6): the max price from a declared
 * reference and a max discount, the escrow (`budget + 30 bps`), the window in nanoseconds within
 * the engine's bounds and the `retire_to` address checked against the class chain.
 */

import { BPS_DENOMINATOR, fee, type Chain, type TenderArgs, type Venue } from "@rose/sdk";
import { isEvmAddress, isSolanaAddress, msToNs } from "@/lib/amounts";
import { durationErrors, horizonError, type WindowBounds } from "@/lib/round-window";
import { dateTimeToSeconds } from "./class-schedule";

/** The EVM burn address convention (`0x…dEaD`) and the Solana incinerator, as retire-to shortcuts. */
export const BURN_ADDRESS: Record<Chain, string> = {
  Base: "0x000000000000000000000000000000000000dead",
  Solana: "1nc1nerator11111111111111111111111111111111",
};

/** `reference × (1 − discount)` rounded down, `discountBps` in basis points (0 to 10,000). */
export function maxPriceFromDiscount(reference: bigint, discountBps: number): bigint {
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) throw new RangeError("The discount must be between 0 and 100 %.");
  return (reference * (BPS_DENOMINATOR - BigInt(discountBps))) / BPS_DENOMINATOR;
}

/** Percent text (`"12.5"`) to basis points, null when not a percentage. */
export function percentToBps(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const bps = Math.round(Number(trimmed) * 100);
  return bps > 10_000 ? null : bps;
}

/** What the issuer escrows at creation: the budget plus the fee on the whole budget. */
export function tenderEscrow(budget: bigint): { fee: bigint; escrow: bigint } {
  const charged = fee(budget);
  return { fee: charged, escrow: budget + charged };
}

/** The engine's `retire_to` rule: a lowercase `0x` address on Base, a base58 key on Solana. */
export function validateRetireTo(chain: Chain, value: string): string | null {
  if (chain === "Base") return isEvmAddress(value) ? null : "Enter a Base address (0x followed by 40 hex characters).";
  return isSolanaAddress(value) ? null : "Enter a Solana address (base58).";
}

/** The address as the engine stores it (lowercase on Base). */
export function canonicalRetireTo(chain: Chain, value: string): string {
  return chain === "Base" ? value.toLowerCase() : value;
}

export type WindowInput = { opensNow: boolean; opensAt: string; closesAt: string };

export type WindowResult = { opensAt: bigint | undefined; closesAt: bigint } | { error: string };

/**
 * Validates the window: `closes_at` after `opens_at` (or now), in the future and at most the
 * engine's round horizon away, as nanosecond timestamps.
 */
export function windowFromInput(input: WindowInput, nowMs: number, limits: WindowBounds): WindowResult {
  const closes = dateTimeToSeconds(input.closesAt);
  if (closes === null) return { error: "Enter when the round closes." };
  const closesNs = closes * 1_000_000_000n;
  const nowNs = msToNs(nowMs);
  if (closesNs <= nowNs) return { error: "The round must close in the future." };
  const tooFar = horizonError(closesNs, nowNs, limits);
  if (tooFar) return { error: tooFar };
  if (input.opensNow) return { opensAt: undefined, closesAt: closesNs };
  const opens = dateTimeToSeconds(input.opensAt);
  if (opens === null) return { error: "Enter when the round opens." };
  const opensNs = opens * 1_000_000_000n;
  if (opensNs < nowNs) return { error: "The round cannot open in the past." };
  if (opensNs >= closesNs) return { error: "The round must close after it opens." };
  return { opensAt: opensNs, closesAt: closesNs };
}

export type TenderFormValues = {
  classId: string;
  chain: Chain;
  venue: Venue;
  budget: bigint;
  mode: "price" | "discount";
  maxPrice: bigint | null;
  referencePrice: bigint | null;
  discountBps: number | null;
  retireTo: string;
  window: WindowInput;
  /** Nanoseconds; null when the field does not hold whole minutes. */
  keyTimeout: bigint | null;
  revealWindow: bigint | null;
};

export type TenderFormResult = { args: TenderArgs } | { error: string };

/** Turns the form into `create_tender` arguments, or the first error to fix. */
export function tenderArgsFromForm(values: TenderFormValues, nowMs: number, limits: WindowBounds): TenderFormResult {
  if (values.budget <= 0n) return { error: "Enter a positive budget." };
  let maxPrice: bigint;
  if (values.mode === "price") {
    if (values.maxPrice === null || values.maxPrice <= 0n) return { error: "Enter a positive max price per locked token." };
    maxPrice = values.maxPrice;
  } else {
    if (values.referencePrice === null || values.referencePrice <= 0n) return { error: "Enter the reference price you declare." };
    if (values.discountBps === null) return { error: "Enter the max discount as a percentage (0 to 100)." };
    maxPrice = maxPriceFromDiscount(values.referencePrice, values.discountBps);
    if (maxPrice <= 0n) return { error: "The discount leaves no price to pay." };
  }
  const retireError = validateRetireTo(values.chain, values.retireTo);
  if (retireError) return { error: retireError };
  const window = windowFromInput(values.window, nowMs, limits);
  if ("error" in window) return { error: window.error };
  const durations = durationErrors({ keyTimeout: values.keyTimeout, revealWindow: values.revealWindow }, limits);
  if (durations.keyTimeout) return { error: durations.keyTimeout };
  if (durations.revealWindow) return { error: durations.revealWindow };
  if (values.keyTimeout === null || values.revealWindow === null) return { error: "Enter the key timeout and reveal window." };
  return {
    args: {
      classId: values.classId,
      venue: values.venue,
      budget: values.budget,
      maxPrice,
      ...(values.referencePrice !== null && values.referencePrice > 0n ? { referencePrice: values.referencePrice } : {}),
      retireTo: canonicalRetireTo(values.chain, values.retireTo),
      window: { closesAt: window.closesAt, ...(window.opensAt !== undefined ? { opensAt: window.opensAt } : {}), keyTimeout: values.keyTimeout, revealWindow: values.revealWindow },
    },
  };
}
