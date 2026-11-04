import { describe, expect, it } from "vitest";
import { formatCash, formatCountdown, formatNearAmount, formatUnits, formatUtcDate, formatUtcDateTime, formatUtcDay, formatUtcTime } from "./format";

describe("formatting", () => {
  it("formats base units with separators and rounds down", () => {
    expect(formatUnits(125_000_000_000n, 6)).toBe("125,000.00");
    expect(formatUnits(1_999_999n, 6, 2)).toBe("1.99");
    expect(formatUnits(5n, 6, 6)).toBe("0.000005");
    expect(formatUnits(0n, 6, 0)).toBe("0");
  });

  it("keeps the significant decimals of cash and prices", () => {
    expect(formatCash(25_000n)).toBe("0.025");
    expect(formatCash(36_000n)).toBe("0.036");
    expect(formatCash(7_200_000n)).toBe("7.20");
    expect(formatCash(113_965_875n)).toBe("113.965875");
    expect(formatCash(1_504_500_000n)).toBe("1,504.50");
    expect(formatCash(0n)).toBe("0.00");
  });

  it("formats NEAR storage amounts without rounding up", () => {
    expect(formatNearAmount(6_190_000_000_000_000_000_000n)).toBe("0.00619");
    expect(formatNearAmount(10n ** 24n)).toBe("1");
  });

  it("prints chain times in UTC whatever the browser zone", () => {
    const ms = Date.UTC(2026, 10, 4, 12, 2, 8);
    expect(formatUtcDateTime(ms)).toBe("4 Nov 2026, 12:02:08 UTC");
    expect(formatUtcTime(ms)).toBe("12:02:08 UTC");
    expect(formatUtcDay(ms)).toBe("4 Nov");
    expect(formatUtcDate(ms)).toBe("4 Nov 2026");
  });

  it("formats countdowns", () => {
    expect(formatCountdown(0)).toBe("00:00:00");
    expect(formatCountdown(-5000)).toBe("00:00:00");
    expect(formatCountdown(((3 * 24 + 4) * 3600 + 12 * 60 + 9) * 1000)).toBe("3d 04:12:09");
  });
});
