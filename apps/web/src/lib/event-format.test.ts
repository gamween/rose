import { describeRoseEvent } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { eventAmountFormat, eventClassIds } from "./event-format";

describe("event amount format", () => {
  const format = eventAmountFormat((classId) => (classId === "seed" ? 18 : null));

  it("prints cash in USDC and units with the class decimals", () => {
    expect(describeRoseEvent({ event: "cash_deposited", data: { account: "a.testnet", venue: "Near", amount: "10000000" } }, format)).toBe("a.testnet deposited 10.00 USDC cash on NEAR");
    expect(describeRoseEvent({ event: "units_minted", data: { class_id: "seed", account: "a.testnet", units: "100000000000000000000000" } }, format)).toBe("100,000.0000 units of seed minted to a.testnet");
  });

  it("keeps the significant decimals of a clearing price (round #6 of engine-s4 cleared at 25000 base units)", () => {
    expect(describeRoseEvent({ event: "round_cleared", data: { round_id: "6", price: "25000", volume: "15000000000000000000000" } } as never, format)).toBe("Round #6 cleared at 0.025 USDC per locked token");
    expect(format.cash("36000")).toBe("0.036 USDC");
    expect(format.cash("113965875")).toBe("113.965875 USDC");
  });

  it("prints NEP-145 storage in NEAR instead of raw yoctoNEAR", () => {
    expect(describeRoseEvent({ event: "storage_deposited", data: { account: "a.testnet", amount: "6190000000000000000000" } } as never, format)).toBe("a.testnet deposited 0.00619 NEAR of storage");
    expect(describeRoseEvent({ event: "storage_deposited", data: { account: "a.testnet", amount: "6190000000000000000000" } } as never)).toBe("a.testnet deposited 6190000000000000000000 yoctoNEAR of storage");
  });

  it("keeps the raw value of a class it does not know", () => {
    expect(format.units("5", "other")).toBe("5");
  });

  it("collects the class ids of a page once", () => {
    expect(eventClassIds([{ event: { data: { class_id: "a" } } }, { event: { data: { class_id: "a" } } }, { event: { data: {} } }])).toEqual(["a"]);
  });
});
