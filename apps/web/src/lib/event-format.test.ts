import { describeRoseEvent } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { eventAmountFormat, eventClassIds } from "./event-format";

describe("event amount format", () => {
  const format = eventAmountFormat((classId) => (classId === "seed" ? 18 : null));

  it("prints cash in USDC and units with the class decimals", () => {
    expect(describeRoseEvent({ event: "cash_deposited", data: { account: "a.testnet", venue: "Near", amount: "10000000" } }, format)).toBe("a.testnet deposited 10.00 USDC cash on NEAR");
    expect(describeRoseEvent({ event: "units_minted", data: { class_id: "seed", account: "a.testnet", units: "100000000000000000000000" } }, format)).toBe("100,000.0000 units of seed minted to a.testnet");
  });

  it("keeps the raw value of a class it does not know", () => {
    expect(format.units("5", "other")).toBe("5");
  });

  it("collects the class ids of a page once", () => {
    expect(eventClassIds([{ event: { data: { class_id: "a" } } }, { event: { data: { class_id: "a" } } }, { event: { data: {} } }])).toEqual(["a"]);
  });
});
