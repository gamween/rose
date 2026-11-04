/** Narrows an optional value in tests, failing loudly instead of using non-null assertions. */
export function must<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`Expected ${what} to be present.`);
  return value;
}
