import { describe, expect, it } from "vitest";
import {
  buildSeries,
  classLabel,
  compactNumber,
  distinctTicks,
  discountToReference,
  groupByToken,
  niceTicks,
  priceDomain,
  toPlottedPoint,
  unlockedPercent,
  type ClassView,
  type PricePoint,
} from "./transforms";

const END = 1_800_000_000;

const seed: ClassView = {
  class_id: "a".repeat(64),
  chain: "Base",
  token: "0x1234567890abcdef1234567890abcdef12345678",
  decimals: 18,
  schedule: { Linear: { start: "1700000000", cliff: "1710000000", end: String(END), granularity: "1", start_unlock: "0", cliff_unlock: "1", total: "10", min_deposit: "1" } },
  positions: 3,
  total_units: "1000",
  fraction_now: "250000000000000000",
  created_at: "0",
};

const kol: ClassView = { ...seed, class_id: "b".repeat(64), schedule: { Stepped: { start: "1700000000", end: String(END + 86_400), period: "60", cliff_amount: "0", amount_per_period: "1", total: "10" } } };

const other: ClassView = { ...seed, class_id: "c".repeat(64), chain: "Solana", token: "So11111111111111111111111111111111111111112", decimals: 9 };

function point(round: string, kind: PricePoint["kind"], price: string, days: number, settledSec: number): PricePoint {
  return { round_id: round, kind, price, remaining_lock_secs: String(days * 86_400), volume: "2500000000000000000000", settled_at: `${settledSec}000000000` };
}

describe("prices transforms", () => {
  it("converts a price point to plotting units with an exact text twin", () => {
    const plotted = toPlottedPoint(point("7", "Tender", "8500000", 90, 1_750_000_000), 18, 10_000_000n);
    expect(plotted).toMatchObject({ roundId: "7", price: 8.5, priceText: "8.5000", remainingLockDays: 90, volumeText: "2,500.00", referencePrice: 10, referenceText: "10.0000" });
    expect(plotted.discount).toBeCloseTo(0.15, 10);
    expect(plotted.settledAtMs).toBe(1_750_000_000_000);
  });

  it("computes the discount only against a positive declared reference", () => {
    expect(discountToReference(9_000_000n, 10_000_000n)).toBeCloseTo(0.1, 10);
    expect(discountToReference(11_000_000n, 10_000_000n)).toBeCloseTo(-0.1, 10);
    expect(discountToReference(9_000_000n, null)).toBeNull();
    expect(discountToReference(9_000_000n, 0n)).toBeNull();
  });

  it("builds one series per class, sorted by settlement, with references only on Tender rounds", () => {
    const histories = new Map([
      [seed.class_id, [point("2", "Exit", "9000000", 80, 1_750_100_000), point("1", "Tender", "8000000", 85, 1_750_000_000)]],
      [kol.class_id, []],
    ]);
    const references = new Map([
      ["1", 10_000_000n],
      ["2", 12_000_000n],
    ]);
    const series = buildSeries([seed, kol], histories, references);
    expect(series.map((item) => item.points.map((p) => p.roundId))).toEqual([["1", "2"], []]);
    expect(series[0]!.points[0]!.discount).toBeCloseTo(0.2, 10);
    expect(series[0]!.points[1]!.discount).toBeNull();
    expect(series[0]!.tokenKey).toBe(`Base:${seed.token}`);
    expect(series[0]!.scheduleEndMs).toBe(END * 1_000);
  });

  it("groups series by token, most settled rounds first, with resolved symbols", () => {
    const histories = new Map([[other.class_id, [point("3", "Exit", "1000000", 10, 1_750_000_000)]]]);
    const groups = groupByToken(buildSeries([seed, kol, other], histories, new Map()), new Map([[`Base:${seed.token}`, "CINDR"]]));
    expect(groups.map((group) => [group.symbol, group.series.length])).toEqual([
      ["So1111…1112", 1],
      ["CINDR", 2],
    ]);
  });

  it("labels a class by chain, schedule end and unlocked share", () => {
    expect(unlockedPercent("250000000000000000")).toBe("25.0%");
    expect(classLabel(seed)).toBe("Base · unlocks until 2027-01-15 · 25.0% unlocked");
  });

  it("produces round axis ticks and domains", () => {
    expect(niceTicks(0, 11)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(niceTicks(0, 0.83)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(niceTicks(0, 100, 6)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 0)).toEqual([0]);
    expect(priceDomain([2, 8.5])[0]).toBe(0);
    expect(priceDomain([2, 8.5])[1]).toBeCloseTo(9.35, 10);
    expect(priceDomain([])).toEqual([0, 1]);
    expect(compactNumber(1_250)).toBe("1.3K");
    expect(compactNumber(0.5)).toBe("0.5");
    expect(compactNumber(12)).toBe("12");
    expect(compactNumber(0.005)).toBe("0.005");
    expect(compactNumber(0.004)).toBe("0.004");
    expect(compactNumber(0.0012)).toBe("0.0012");
    expect(compactNumber(0.25)).toBe("0.25");
  });

  it("drops ticks whose label repeats the previous one", () => {
    expect(distinctTicks([0, 0.4, 1, 1.6, 2], (value) => String(Math.floor(value)))).toEqual([0, 1, 2]);
  });
});
