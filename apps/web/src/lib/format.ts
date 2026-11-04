const integerFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return integerFormat.format(value);
}

/**
 * Formats an integer amount expressed in base units (for example USDC with 6 decimals) as a
 * human-readable decimal string with thousands separators, rounding down to `fractionDigits`.
 */
export function formatUnits(amount: bigint, decimals: number, fractionDigits = 2): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const shown = Math.min(fractionDigits, decimals);
  const fractionText = shown > 0 ? fraction.toString().padStart(decimals, "0").slice(0, shown) : "";
  const body = fractionText ? `${wholeText}.${fractionText}` : wholeText;
  return negative ? `-${body}` : body;
}

/**
 * Cash in USDC base units (6 decimals in every venue) with its significant decimals: at least
 * two fraction digits, trailing zeros beyond them dropped, never rounded (`7.20`, `0.025`,
 * `113.965875`). Clearing prices of locked tokens often sit below 0.05, so a fixed two-digit
 * format would misstate them.
 */
export function formatCash(amount: bigint): string {
  const full = formatUnits(amount, 6, 6);
  const [whole, fraction = ""] = full.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole ?? "0"}.${trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed}`;
}

/** yoctoNEAR as NEAR with up to five decimals, never rounded up (`0.00619`). */
export function formatNearAmount(yocto: bigint): string {
  const full = formatUnits(yocto, 24, 5);
  const [whole, fraction = ""] = full.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length > 0 ? `${whole ?? "0"}.${trimmed}` : (whole ?? "0");
}

const utcDateTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
const utcTime = new Intl.DateTimeFormat("en-GB", { timeStyle: "medium", timeZone: "UTC" });
const utcDay = new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });
const utcDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/** `4 Nov 2026, 12:02:08 UTC`: chain times are shown in UTC on every page, like the round pages and the demo. */
export function formatUtcDateTime(ms: number): string {
  return `${utcDateTime.format(new Date(ms))} UTC`;
}

/** `12:02:08 UTC`. */
export function formatUtcTime(ms: number): string {
  return `${utcTime.format(new Date(ms))} UTC`;
}

/** `4 Nov` in UTC, for chart axes. */
export function formatUtcDay(ms: number): string {
  return utcDay.format(new Date(ms));
}

/** `4 Nov 2026` in UTC. */
export function formatUtcDate(ms: number): string {
  return utcDate.format(new Date(ms));
}

export type CountdownParts ={ days: number; hours: number; minutes: number; seconds: number };

export function countdownParts(remainingMs: number): CountdownParts {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  };
}

export function formatCountdown(remainingMs: number): string {
  const { days, hours, minutes, seconds } = countdownParts(remainingMs);
  const pad = (value: number) => value.toString().padStart(2, "0");
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}
