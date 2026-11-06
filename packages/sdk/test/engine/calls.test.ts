import { describe, expect, it } from "vitest";
import { BID_STORAGE_DEPOSIT, depositNearCashCall, distributeUnitsGas, EngineCalls, GAS, mintTestUsdcCall, ONE_YOCTO, ROUND_STORAGE_DEPOSIT, sideIndex, TGAS } from "../../src/engine/calls.js";

describe("engine change-call builders", () => {
  const calls = new EngineCalls("engine.rose-app.testnet");

  it("encodes a tender with U128 strings, the storage deposit and null optionals", () => {
    const call = calls.createTender({
      classId: "c",
      venue: { Base: { token: "0xabc" } },
      budget: 950_000_000n,
      maxPrice: 12_000_000n,
      retireTo: "0x000000000000000000000000000000000000dead",
      window: { closesAt: 1_793_763_600_000_000_000n, revealWindow: 600_000_000_000n },
    });
    expect(call).toEqual({
      receiverId: "engine.rose-app.testnet",
      methodName: "create_tender",
      args: {
        params: {
          class_id: "c",
          venue: { Base: { token: "0xabc" } },
          budget: "950000000",
          max_price: "12000000",
          reference_price: null,
          retire_to: "0x000000000000000000000000000000000000dead",
          window: { opens_at: null, closes_at: "1793763600000000000", key_timeout: null, reveal_window: "600000000000" },
        },
      },
      gas: GAS.simple,
      deposit: ROUND_STORAGE_DEPOSIT,
    });
    expect(ROUND_STORAGE_DEPOSIT).toBe(50_000_000_000_000_000_000_000n);
    expect(BID_STORAGE_DEPOSIT).toBe(20_000_000_000_000_000_000_000n);
  });

  it("attaches the bid storage deposit to sealed orders and 1 yocto to transfers", () => {
    expect(calls.placeBid(7n, "ab".repeat(192), 1_000_000n)).toMatchObject({ methodName: "place_bid", deposit: BID_STORAGE_DEPOSIT, args: { escrow: "1000000" } });
    expect(calls.placeAsk(7n, "ab".repeat(192), 5n)).toMatchObject({ methodName: "place_ask", args: { units: "5" } });
    expect(calls.mtTransfer("b.testnet", "c", 5n)).toMatchObject({ deposit: ONE_YOCTO, args: { approval: null, memo: null, amount: "5" } });
    expect(calls.distributeUnits("c", [{ account: "b.testnet", units: 5n }]).args).toEqual({ token_id: "c", receivers: [["b.testnet", "5"]] });
  });

  it("sizes distribute_units gas from the receiver count, under the wallet cap at the engine's bound", () => {
    expect(distributeUnitsGas(1)).toBe(11n * TGAS);
    expect(distributeUnitsGas(30)).toBe(40n * TGAS);
    const receivers = Array.from({ length: 30 }, (_, i) => ({ account: `${String(i).padStart(2, "0")}${"a".repeat(62)}`, units: 10n ** 37n }));
    const call = calls.distributeUnits("c", receivers, 30n);
    expect(call.gas).toBe(40n * TGAS);
    expect(call.deposit).toBe(30n);
    expect(calls.distributeUnits("c", receivers.slice(0, 2)).gas).toBe(12n * TGAS);
  });

  it("keeps every call under the 300 Tgas wallet cap and gives opening and clearing the maximum", () => {
    expect(calls.openBid(7n, 0, "00".repeat(48), "00".repeat(32)).gas).toBe(200n * TGAS);
    expect(calls.clear(7n).gas).toBe(50n * TGAS);
    expect(calls.close(7n).deposit).toBe(0n);
    for (const gas of Object.values(GAS)) expect(gas <= 300n * TGAS).toBe(true);
  });

  it("builds the NEP-141 deposit and mint calls", () => {
    expect(depositNearCashCall("tusdc.rose-app.testnet", "engine.rose-app.testnet", 10n)).toMatchObject({
      receiverId: "tusdc.rose-app.testnet",
      methodName: "ft_transfer_call",
      args: { receiver_id: "engine.rose-app.testnet", amount: "10", msg: "" },
      deposit: ONE_YOCTO,
    });
    expect(mintTestUsdcCall("tusdc.rose-app.testnet", 1_000_000n, 1_250_000_000_000_000_000_000n)).toMatchObject({ methodName: "mint", args: { amount: "1000000" } });
  });

  it("maps sides to the associated-data byte of the engine", () => {
    expect(sideIndex("Buy")).toBe(0);
    expect(sideIndex("Sell")).toBe(1);
  });
});
