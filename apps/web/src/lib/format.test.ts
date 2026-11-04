import { describe, expect, it } from "vitest";
import { formatCountdown, formatUnits } from "./format";

describe("formatting", () => {
  it("formats base units with separators and rounds down", () => {
    expect(formatUnits(125_000_000_000n, 6)).toBe("125,000.00");
    expect(formatUnits(1_999_999n, 6, 2)).toBe("1.99");
    expect(formatUnits(5n, 6, 6)).toBe("0.000005");
    expect(formatUnits(0n, 6, 0)).toBe("0");
  });

  it("formats countdowns", () => {
    expect(formatCountdown(0)).toBe("00:00:00");
    expect(formatCountdown(-5000)).toBe("00:00:00");
    expect(formatCountdown(((3 * 24 + 4) * 3600 + 12 * 60 + 9) * 1000)).toBe("3d 04:12:09");
  });
});
