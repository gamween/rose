/**
 * Checks the bindings against the ABI produced by `cargo near build non-reproducible-wasm`
 * (`target/near/rose_engine/rose_engine_abi.json`): every method called by the bindings exists
 * with the same parameter names and kind, and the fixtures carry exactly the keys of the ABI's
 * type definitions. Skipped when the ABI has not been built on this machine.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EngineCalls } from "../../src/engine/calls.js";
import { EngineRawViews } from "../../src/engine/views.js";
import { NearRpc } from "../../src/engine/rpc.js";
import { classView, eventsPageView, portfolioView, roundView, statsView } from "./fixtures.js";

interface AbiParam { name: string }
interface AbiFunction { name: string; kind: "view" | "call"; params?: { args: AbiParam[] }; modifiers?: string[] }
interface AbiSchema { properties?: Record<string, unknown>; required?: string[] }
interface Abi { body: { functions: AbiFunction[]; root_schema: { definitions: Record<string, AbiSchema> } } }

const ABI_PATH = resolve(import.meta.dirname, "../../../../target/near/rose_engine/rose_engine_abi.json");

/** Records the `(method, args)` of every view the bindings send, without touching the network. */
function recordedViews(): { calls: { method: string; args: string[] }[]; views: EngineRawViews } {
  const calls: { method: string; args: string[] }[] = [];
  const fetchImpl: typeof globalThis.fetch = (_, init) => {
    const body = JSON.parse((init?.body as string)) as { params: { method_name: string; args_base64: string } };
    calls.push({ method: body.params.method_name, args: Object.keys(JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()) as object) });
    return Promise.resolve(new Response(JSON.stringify({ result: { result: [...Buffer.from("null")], block_height: 1 } })));
  };
  return { calls, views: new EngineRawViews(new NearRpc({ fetch: fetchImpl, endpoints: ["http://abi.test"] }), "engine.test") };
}

describe.skipIf(!existsSync(ABI_PATH))("engine ABI", () => {
  const abi = JSON.parse(readFileSync(ABI_PATH, "utf8")) as Abi;
  const functions = new Map(abi.body.functions.map((f) => [f.name, f]));
  const definitions = abi.body.root_schema.definitions;

  it("every view binding names an existing view method with the ABI's parameter names", async () => {
    const { calls, views } = recordedViews();
    await views.stats();
    await views.getConfig();
    await views.getLimits();
    await views.getClass("c");
    await views.getClasses(0, 10);
    await views.getPosition(1n);
    await views.getPositions(0n, 10);
    await views.getRound(1n);
    await views.getRounds({ kind: "Exit" }, 0n, 10);
    await views.getBids(1n);
    await views.getBid(1n, 0);
    await views.getOrderId(1n, "a.testnet", "Buy");
    await views.getRoundResult(1n);
    await views.getHolding("a.testnet", "c");
    await views.getRetiredLot(1n);
    await views.getPortfolio("a.testnet");
    await views.getCash("a.testnet");
    await views.getLiens("a.testnet");
    await views.getLien(1n);
    await views.getPriceHistory("c");
    await views.getEvents(0n, 10);
    await views.quoteBuy(1n, 1n, 1n);
    await views.quoteSell(1n, 1n);
    await views.getClaimable("a.testnet", "c");
    await views.mtBalanceOf("a.testnet", "c");
    await views.mtBatchBalanceOf("a.testnet", ["c"]);
    await views.mtSupply("c");
    await views.mtBatchSupply(["c"]);
    await views.mtToken(["c"]);
    await views.storageBalanceBounds();
    await views.storageBalanceOf("a.testnet");
    await views.getPayout(1n);
    await views.getPayouts("a.testnet", 0, 10);
    await views.payoutsTotal();
    await views.getPendingRelease(1n);
    await views.getRefusedDeposit({ SolStream: { metadata: "m" } });
    await views.getReplay({ SolStream: { metadata: "m" } });
    await views.getSolDeposit("m");
    await views.getSolStream(1n);
    await views.registrationDepositFor("a.testnet", "c");
    await views.computeBaseClassId("0x1", 18, { start: 1, cliff: 2, end: 3, granularity: 1, deposited: "1", start_unlock: "0", cliff_unlock: "0" });
    await views.computeSolClassId("m", 6, { start_time: 1, end_time: 2, net_amount_deposited: 1, period: 1, amount_per_period: 1, cliff: 1, cliff_amount: 0 });
    await views.depositPathOf("a.testnet", "c");
    expect(calls.length).toBe(43);
    for (const call of calls) {
      const fn = functions.get(call.method);
      expect(fn, call.method).toBeDefined();
      expect(fn?.kind, call.method).toBe("view");
      expect(call.args.sort(), call.method).toEqual((fn?.params?.args ?? []).map((p) => p.name).sort());
    }
  });

  it("every change-call builder names an existing call method with the ABI's parameter names and payability", () => {
    const calls = new EngineCalls("engine.test");
    const window = { closesAt: 1n };
    const built = [
      calls.createTender({ classId: "c", venue: "Near", budget: 1n, maxPrice: 1n, retireTo: "t.testnet", window }),
      calls.createExit({ classId: "c", venue: "Near", maxPrice: 1n, window }),
      calls.createAdvance({ classId: "c", venue: "Near", units: 1n, claim: 1n, minFill: 1n, maxPrice: 1n, window }),
      calls.cancelRound(1n),
      calls.placeBid(1n, "00", 1n),
      calls.placeAsk(1n, "00", 1n),
      calls.close(1n),
      calls.submitKey(1n, "k"),
      calls.cancelNoKey(1n),
      calls.openBid(1n, 0, "00", "00"),
      calls.clear(1n),
      calls.settleBid(1n, 0),
      calls.releaseLien(1n),
      calls.withdrawNearCash(1n),
      calls.mtTransfer("b.testnet", "c", 1n),
      calls.mtBatchTransfer("b.testnet", ["c"], [1n]),
      calls.mtTransferCall("b.testnet", "c", 1n, "msg"),
      calls.distributeUnits("c", [{ account: "b.testnet", units: 1n }]),
      calls.storageDeposit(1n),
      calls.storageWithdraw(),
      calls.storageUnregister(),
      calls.bootstrap(),
      calls.registerBaseDeposit({ tx_hash: "0x1", block_hash: "0x2", block_number: 1, transaction_index: 0, log_index: 0 }, {}, 1n),
      calls.registerBaseCash({ tx_hash: "0x1", block_hash: "0x2", block_number: 1, transaction_index: 0, log_index: 0 }, {}),
      calls.attributeSolDeposit({ metadata: "m", class_id: "c", return_to: "r", anchor_tx: "t", metadata_data: "00", mint_data: "00" }),
      calls.moveSolDeposit("m", "b"),
      calls.registerSolDeposit("m", "t", "00", 1n),
      calls.withdrawSolStream(1n, "b"),
      calls.claimBaseTokens({ Holding: { class_id: "c" } }, 1n, "0x1"),
      calls.withdrawBaseCash("0x1", 1n, "0x2"),
      calls.claimSolTokens({ Retired: { round_id: "1" } }, 1n, "o", { account: "n", anchor_tx: "t", data: "00" }),
      calls.resignSolGas(1n),
      calls.redeem(1n, "0x1"),
      calls.returnRefusedDeposit({ BaseLog: { tx_hash: "0x1", log_index: 0 } }),
    ];
    for (const call of built) {
      const fn = functions.get(call.methodName);
      expect(fn, call.methodName).toBeDefined();
      expect(fn?.kind, call.methodName).toBe("call");
      expect(Object.keys(call.args).sort(), call.methodName).toEqual((fn?.params?.args ?? []).map((p) => p.name).sort());
      const payable = fn?.modifiers?.includes("payable") ?? false;
      if (call.deposit > 0n) expect(payable, `${call.methodName} must be payable`).toBe(true);
    }
  });

  it("fixtures carry exactly the keys of the ABI type definitions", () => {
    const keysOf = (name: string) => Object.keys(definitions[name]?.properties ?? {}).sort();
    const check = (name: string, value: object) => {
      expect(Object.keys(value).sort(), name).toEqual(keysOf(name));
    };
    check("Stats", statsView);
    check("ClassView", classView);
    check("RoundView", roundView);
    check("RoundResult", roundView.result ?? {});
    check("BidOutcome", roundView.result?.fills[0] ?? {});
    check("PortfolioView", portfolioView);
    check("HoldingView", portfolioView.holdings[0] ?? {});
    check("BidView", portfolioView.bids[0] ?? {});
    check("LienView", portfolioView.liens_held[0] ?? {});
    check("LienShareView", portfolioView.lien_shares[0] ?? {});
    check("CashView", portfolioView.cash[0] ?? {});
    check("EventsPage", eventsPageView);
    const stored = eventsPageView.events[0] ?? {};
    expect(keysOf("StoredEvent").every((key) => key in stored)).toBe(true);
  });
});
