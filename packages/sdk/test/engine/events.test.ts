import { describe, expect, it } from "vitest";
import { decodeEventLog, decodeEventLogs, describeRoseEvent, nep245Events, roseEvents } from "../../src/engine/events.js";
import { parseEventsPage } from "../../src/engine/parse.js";

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
      "Round #7 cleared at 9000000 per locked token",
    );
    const format = { cash: (amount: string) => `${String(Number(amount) / 1e6)} USDC`, units: (amount: string, classId: string) => `${amount}@${classId}` };
    expect(describeRoseEvent({ event: "cash_deposited", data: { account: "a.testnet", venue: "Near", amount: "10000000" } }, format)).toBe("a.testnet deposited 10 USDC cash on NEAR");
    expect(describeRoseEvent({ event: "units_minted", data: { class_id: "4e7a", account: "a.testnet", units: "5" } }, format)).toBe("5@4e7a units of 4e7a minted to a.testnet");
    expect(describeRoseEvent({ event: "bid_opened", data: { round_id: "7", bid_id: 2, quantity: "1", price: "2", void: "EscrowTooSmall" } })).toContain("void (EscrowTooSmall)");
    expect(describeRoseEvent({ event: "cash_deposited", data: { account: "a.testnet", venue: "Near", amount: "5" } })).toBe("a.testnet deposited 5 cash on NEAR");
  });

  it("decodes the custody events and the unit variants that carry no data", () => {
    expect(decodeEventLog('EVENT_JSON:{"standard":"rose","version":"1.0.0","event":"bootstrap_requested"}')).toEqual({
      standard: "rose",
      version: "1.0.0",
      event: { event: "bootstrap_requested", data: {} },
    });
    const payout = decodeEventLog('EVENT_JSON:{"standard":"rose","version":"1.0.0","event":"payout_requested","data":{"payout_id":"3","chain":"Base","requester":"a.testnet"}}');
    expect(payout?.standard).toBe("rose");
    expect(payout?.event).toEqual({ event: "payout_requested", data: { payout_id: "3", chain: "Base", requester: "a.testnet" } });
    expect(describeRoseEvent({ event: "payout_requested", data: { payout_id: "3", chain: "Base", requester: "a.testnet" } })).toBe("Base payout #3 requested by a.testnet");
    expect(describeRoseEvent({ event: "deposit_refused", data: { key: { BaseLog: { tx_hash: "0xabcdef0123456789", log_index: 4 } }, reason: "cancelable" } })).toBe(
      "Deposit 0xabcdef01…#4 refused (cancelable)",
    );
  });

  it("parses a live get_events page whose first event has no data", () => {
    // Shape returned by engine-s2.rose-app.testnet (`get_events`, from_index 0) on 2026-11-04.
    const page = parseEventsPage({
      events: [
        { seq: "0", block_height: "276148194", timestamp: "1793767807032547184", predecessor: "engine-s2.rose-app.testnet", event: "bootstrap_requested" },
        {
          seq: "3",
          block_height: "276148345",
          timestamp: "1793767893286095765",
          predecessor: "b2.rose-ckd-1793753433.testnet",
          event: "payout_requested",
          data: { payout_id: "0", chain: "Solana", requester: "b2.rose-ckd-1793753433.testnet" },
        },
      ],
      total: "32",
      oldest: "0",
    } as never);
    expect(page.events[0]?.event).toEqual({ event: "bootstrap_requested", data: {} });
    expect(page.events[1]?.event.event).toBe("payout_requested");
    expect(page.events.map((entry) => describeRoseEvent(entry.event))).toEqual([
      "Engine bootstrap requested (MPC-derived foreign addresses)",
      "Solana payout #0 requested by b2.rose-ckd-1793753433.testnet",
    ]);
  });
});
