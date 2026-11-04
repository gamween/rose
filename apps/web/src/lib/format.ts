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

export type CountdownParts = { days: number; hours: number; minutes: number; seconds: number };

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
