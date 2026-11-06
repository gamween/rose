/**
 * Amount parsing and formatting shared by the app pages. Every engine amount is a `bigint` in
 * base units; text inputs are parsed exactly (no floats), fractions are the engine's 1e18
 * fixed point, timestamps come in nanoseconds (NEAR) or seconds (foreign chains).
 */

import { ONE, type Venue } from "@rose/sdk";
import { USDC_DECIMALS } from "./engine";
import { formatUnits } from "./format";
import { deployedCashSymbol } from "./token-symbols";

/** Parses a decimal string typed by a person into base units; null when it is not a valid amount. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const trimmed = text.trim().replace(",", ".");
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole = "", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  const digits = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return BigInt(digits === "" ? "0" : digits);
}

/** Base units as a decimal string without separators, exact (the inverse of `parseAmount`). */
export function amountToText(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = amount % base;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

/** Human-readable amount with separators, showing up to `digits` decimals (4 by default). */
export function formatAmount(amount: bigint, decimals: number, digits = 4): string {
  return formatUnits(amount, decimals, digits);
}

export function formatUsdc(amount: bigint, digits = 2): string {
  return formatUnits(amount, USDC_DECIMALS, digits);
}

/** A 1e18 fixed-point fraction as a percentage with one decimal (`"25.0%"`). */
export function formatFraction(fraction: bigint, digits = 1): string {
  const scaled = (fraction * 10n ** BigInt(digits + 2)) / ONE;
  const whole = scaled / 10n ** BigInt(digits);
  const rest = scaled % 10n ** BigInt(digits);
  return digits === 0 ? `${whole.toString()}%` : `${whole.toString()}.${rest.toString().padStart(digits, "0")}%`;
}

/** `floor(units * fraction / ONE)`: tokens represented by `units` at a class fraction. */
export function tokensAtFraction(units: bigint, fraction: bigint): bigint {
  return (units * fraction) / ONE;
}

export function nsToMs(nanoseconds: bigint): number {
  return Number(nanoseconds / 1_000_000n);
}

export function secondsToMs(seconds: bigint | number): number {
  return Number(seconds) * 1000;
}

export function msToNs(milliseconds: number): bigint {
  return BigInt(Math.floor(milliseconds)) * 1_000_000n;
}

export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/** `1d 4h`, `3h 12m`, `45m`, `20s` for a duration in seconds. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m`;
  return `${String(total)}s`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC";
}

export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" });
}

/** `3f2a…9c1e` for class ids and other long hex identifiers. */
export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function venueLabel(venue: Venue, symbols: ReadonlyMap<string, string> = new Map()): string {
  if (venue === "Near") return "NEAR tUSDC";
  const token = venue.Base.token.toLowerCase();
  return `Base ${symbols.get(token) ?? deployedCashSymbol(token) ?? shortHex(token)}`;
}

/** Decimals of a venue's cash: 6 for NEAR tUSDC, the Base token's `decimals()` from `known` (keyed by lowercase address), null when unread. */
export function cashDecimalsOf(venue: Venue, known: ReadonlyMap<string, number>): number | null {
  if (venue === "Near") return USDC_DECIMALS;
  return known.get(venue.Base.token.toLowerCase()) ?? null;
}

/** Venue cash at its token's decimals with two fraction digits; the exact base units, labeled, while the decimals are unknown. */
export function formatVenueCash(amount: bigint, decimals: number | null): string {
  return decimals === null ? `${amount.toString()} base units` : formatUnits(amount, decimals, 2);
}

export function venueChain(venue: Venue): "near" | "base" {
  return venue === "Near" ? "near" : "base";
}

export function sameVenue(a: Venue, b: Venue): boolean {
  if (a === "Near" || b === "Near") return a === b;
  return a.Base.token.toLowerCase() === b.Base.token.toLowerCase();
}

/** A 20-byte EVM address (`0x` + 40 hex). */
export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** A Solana address: base58 of 32 bytes (32 to 44 characters of the base58 alphabet). */
export function isSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/** NEAR account id rules (2 to 64 characters, lowercase alphanumerics, `-`, `_`, dot-separated parts). */
export function isNearAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value);
}
