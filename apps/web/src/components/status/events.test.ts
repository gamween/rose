import { describe, expect, it } from "vitest";
import { parsePage } from "./events";

describe("get_events parsing", () => {
  it("accepts the unit variants the engine stores without data", () => {
    // First events of engine-s2.rose-app.testnet (`get_events`, from_seq 0) on 2026-11-04.
    const page = parsePage({
      events: [
        { seq: "0", block_height: "276148194", timestamp: "1793767807032547184", predecessor: "engine-s2.rose-app.testnet", event: "bootstrap_requested" },
        { seq: "4", block_height: "276148353", timestamp: "1793767897321374536", predecessor: "engine-s2.rose-app.testnet", event: "payout_signed", data: { payout_id: "0" } },
      ],
      total: "32",
      oldest: "0",
    });
    expect(page.events.map((event) => event.data)).toEqual([{}, { payout_id: "0" }]);
    expect(page.total).toBe("32");
  });

  it("still refuses a malformed entry", () => {
    expect(() => parsePage({ events: [{ seq: 1 }], total: "1", oldest: "0" })).toThrow("get_events returned malformed events.");
    expect(() => parsePage({ events: [{ seq: "0", block_height: "1", timestamp: "1", event: "x", data: "nope" }], total: "1", oldest: "0" })).toThrow("malformed");
  });
});
