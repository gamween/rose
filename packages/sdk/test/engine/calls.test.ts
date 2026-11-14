import { describe, expect, it } from "vitest";
import {
  BID_STORAGE_DEPOSIT,
  CASH_ROW_STORAGE_DEPOSIT,
  depositNearCashCall,
  distributeUnitsGas,
  EngineCalls,
  GAS,
  mintTestUsdcCall,
  ONE_NEAR,
  ONE_YOCTO,
  PAYOUT_STORAGE_DEPOSIT,
  RECORD_STORAGE_DEPOSIT,
  ROUND_STORAGE_DEPOSIT,
  sideIndex,
  TGAS,
  type FunctionCall,
} from "../../src/engine/calls.js";

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

  it("pins the storage deposits the engine charges (0.025, 0.015 NEAR and a 172-byte cash row)", () => {
    expect(PAYOUT_STORAGE_DEPOSIT).toBe((ONE_NEAR * 25n) / 1000n);
    expect(RECORD_STORAGE_DEPOSIT).toBe((ONE_NEAR * 15n) / 1000n);
    expect(CASH_ROW_STORAGE_DEPOSIT).toBe(1_720_000_000_000_000_000_000n);
  });

  it("attaches the gas and deposit the spec and the engine require to every custody call", () => {
    const registration = 7n;
    const nonce = { anchor_tx: "a", nonce_data: "n", receipt_data: "r", recipient_tokens_data: "t" } as never;
    const source = { Holding: { class_id: "c" } } as never;
    const table: [FunctionCall, string, bigint, bigint][] = [
      [calls.bootstrap(), "bootstrap", 80n, 0n],
      [calls.registerBaseDeposit({} as never, {} as never, registration), "register_base_deposit", 80n, registration],
      [calls.registerBaseCash({} as never, {} as never), "register_base_cash", 80n, RECORD_STORAGE_DEPOSIT],
      [calls.attributeSolDeposit({} as never), "attribute_sol_deposit", 120n, RECORD_STORAGE_DEPOSIT],
      [calls.moveSolDeposit("m", "b"), "move_sol_deposit", 120n, PAYOUT_STORAGE_DEPOSIT],
      [calls.registerSolDeposit("m", "a", "00", registration), "register_sol_deposit", 80n, registration],
      [calls.claimBaseTokens(source, 1n, "0x0"), "claim_base_tokens", 80n, PAYOUT_STORAGE_DEPOSIT],
      [calls.withdrawBaseCash("0x0", 1n, "0x0"), "withdraw_base_cash", 80n, PAYOUT_STORAGE_DEPOSIT],
      [calls.claimSolTokens(source, [], "o", nonce, 1n), "claim_sol_tokens", 200n, PAYOUT_STORAGE_DEPOSIT],
      [calls.confirmSolPayout(1n, "a", "n", "r"), "confirm_sol_payout", 100n, 0n],
      [calls.confirmSolRedeem(1n, "a", "n", "r"), "confirm_sol_redeem", 100n, 0n],
      [calls.syncSolStream(1n, "a", "00"), "sync_sol_stream", 80n, 0n],
      [calls.retrySolPayout(1n), "retry_sol_payout", 120n, 0n],
      [calls.resignSolGas(1n), "resign_sol_gas", 120n, 0n],
      [calls.retryBaseSignature(1n), "retry_base_signature", 80n, 0n],
      [calls.redeem(1n, "0x0"), "redeem", 80n, PAYOUT_STORAGE_DEPOSIT],
      [calls.redeem(1n, "o", nonce), "redeem", 200n, PAYOUT_STORAGE_DEPOSIT],
      [calls.returnRefusedDeposit({ SolStream: { metadata: "m" } }, "b"), "return_refused_deposit", 120n, PAYOUT_STORAGE_DEPOSIT],
    ];
    for (const [call, methodName, tgas, deposit] of table) expect({ methodName: call.methodName, gas: call.gas, deposit: call.deposit }).toEqual({ methodName, gas: tgas * TGAS, deposit });
  });

  it("keeps every call under the 300 Tgas wallet cap and gives opening the maximum", () => {
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
