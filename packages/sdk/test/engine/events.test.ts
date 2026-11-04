import { describe, expect, it } from "vitest";
import { decodeEventLog, decodeEventLogs, describeRoseEvent, nep245Events, roseEvents } from "../../src/engine/events.js";

/** Logs exactly as the engine emits them (`events.rs` and `units.rs`). */
const ROSE_LOG =
  'EVENT_JSON:{"standard":"rose","version":"1.0.0","event":"round_created","data":{"round_id":"7","kind":"Exit","class_id":"4e7a","venue":"Near","creator":"a.testnet","opens_at":"1","closes_at":"2","max_price":"12000000"}}';
const MINT_LOG = 'EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{"owner_id":"a.testnet","token_ids":["4e7a"],"amounts":["100"]}]}';
const TRANSFER_LOG =
  'EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[{"old_owner_id":"a.testnet","new_owner_id":"b.testnet","token_ids":["4e7a"],"amounts":["5"],"memo":"gift"}]}';

describe("event decoding", () => {
  it("decodes a rose event and a NEP-245 event, ignoring plain logs", () => {
    const decoded = decodeEventLogs(["plain log", ROSE_LOG, MINT_LOG, "EVENT_JSON:not json"]);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toEqual({
      standard: "rose",
      version: "1.0.0",
      event: {
        event: "round_created",
        data: { round_id: "7", kind: "Exit", class_id: "4e7a", venue: "Near", creator: "a.testnet", opens_at: "1", closes_at: "2", max_price: "12000000" },
      },
    });
    expect(decoded[1]?.standard).toBe("nep245");
  });

  it("separates rose and NEP-245 events", () => {
    const logs = [ROSE_LOG, MINT_LOG, TRANSFER_LOG];
    expect(roseEvents(logs).map((e) => e.event)).toEqual(["round_created"]);
    const mt = nep245Events(logs);
    expect(mt.map((e) => e.event)).toEqual(["mt_mint", "mt_transfer"]);
    expect(mt[1]?.data[0]).toMatchObject({ old_owner_id: "a.testnet", new_owner_id: "b.testnet", memo: "gift" });
  });

  it("keeps unknown standards as generic events", () => {
    const decoded = decodeEventLog('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{"owner_id":"a","amount":"1"}]}');
    expect(decoded?.standard).toBe("nep141");
    expect(decoded?.event.event).toBe("ft_mint");
  });

  it("describes every event in one line", () => {
    expect(describeRoseEvent({ event: "round_cleared", data: { round_id: "7", price: "9000000", volume: "10", notional: "90", fee: "1", remaining_lock_secs: "5" } })).toBe(
      "Round #7 cleared at 9000000 (volume 10)",
    );
    expect(describeRoseEvent({ event: "bid_opened", data: { round_id: "7", bid_id: 2, quantity: "1", price: "2", void: "EscrowTooSmall" } })).toContain("void (EscrowTooSmall)");
    expect(describeRoseEvent({ event: "cash_deposited", data: { account: "a.testnet", venue: "Near", amount: "5" } })).toBe("a.testnet deposited 5 cash on NEAR");
  });
});
