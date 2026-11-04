/**
 * Pure rules of an Advance (spec 4 "Advance", 5.3, 5.4): the largest claim a holder can sell on
 * `X` units, the holder's bond, and the form validation that mirrors `create_advance`.
 */

import { charge, ONE, perClaimedToken } from "@rose/sdk";
import { formatAmount, formatUsdc } from "@/lib/amounts";

/** `K_max = floor(X * (1 - f(ts)) / ONE)`: the tokens still locked at settlement by `units`. */
export function maxClaim(units: bigint, fTs: bigint): bigint {
  const locked = fTs >= ONE ? 0n : ONE - fTs;
  return (units * locked) / ONE;
}

/** Holder's bond: `max(bondFloor, 1% of the claim valued at the max price per claimed token)`. */
export function holderBond(claim: bigint, maxPrice: bigint, decimals: number, bondFloor: bigint): bigint {
  const valuation = charge(perClaimedToken(decimals), claim, maxPrice);
  const percent = valuation / 100n;
  return percent > bondFloor ? percent : bondFloor;
}

export type AdvanceForm = {
  units: bigint | null;
  claim: bigint | null;
  reserve: bigint | null;
  minFill: bigint | null;
  maxPrice: bigint | null;
  closesAtMs: number | null;
};

export type AdvanceFormErrors = Partial<Record<keyof AdvanceForm, string>>;

/** Validation of the create form against the holder's free units, `f(ts)` and the clock. */
export function validateAdvance(form: AdvanceForm, context: { freeUnits: bigint; fTs: bigint; nowMs: number; cash: bigint; bond: bigint | null; decimals: number }): AdvanceFormErrors {
  const errors: AdvanceFormErrors = {};
  if (form.units === null) errors.units = "Enter the units to encumber";
  else if (form.units === 0n) errors.units = "Units must be positive";
  else if (form.units > context.freeUnits) errors.units = "More than your free units";
  if (context.fTs >= ONE) errors.closesAtMs = "The class is fully unlocked at that time: nothing is left to claim";
  const kMax = form.units === null ? 0n : maxClaim(form.units, context.fTs);
  if (form.claim === null) errors.claim = "Enter the claim K";
  else if (form.claim === 0n) errors.claim = "The claim must be positive";
  else if (form.units !== null && form.claim > kMax) errors.claim = `At most ${formatAmount(kMax, context.decimals)} tokens are still locked at settlement`;
  if (form.minFill === null) errors.minFill = "Enter the minimum fill";
  else if (form.claim !== null && form.minFill > form.claim) errors.minFill = "The minimum fill cannot exceed the claim";
  if (form.maxPrice === null || form.maxPrice === 0n) errors.maxPrice = "Enter a positive price ceiling";
  if (form.reserve === null) errors.reserve = "Enter your sealed reserve price";
  else if (form.maxPrice !== null && form.reserve > form.maxPrice) errors.reserve = "The reserve cannot exceed the price ceiling (it would never fill)";
  if (form.closesAtMs === null) errors.closesAtMs ??= "Choose when bidding closes";
  else if (form.closesAtMs <= context.nowMs + 60_000) errors.closesAtMs ??= "Bidding must close at least a minute from now";
  if (context.bond !== null && context.cash < context.bond) errors.maxPrice ??= `Your cash in the venue (${formatUsdc(context.cash)} USDC) does not cover the ${formatUsdc(context.bond)} USDC bond`;
  return errors;
}
