import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTEMPTED_DEPOSITS_KEY, awaitsRegistration, cashAttempts, forgetAttempted, loadAttempted, matchCashLog, recordAttempted, type AttemptedDeposit } from "./attempted";

const TX = `0x${"7".repeat(64)}`;
const TOKEN = "0x3333333333333333333333333333333333333333";
const VAULT = "0x1111111111111111111111111111111111111111";

function cash(logIndex: number, creditTo = "dao.sputnik-v2.testnet", token = TOKEN): AttemptedDeposit {
  return { key: { BaseLog: { tx_hash: TX.slice(2), log_index: logIndex } }, chain: "base", label: "depositCash of 1,000.00 tUSDC", nearAccount: creditTo, attemptedAt: 1, baseTx: TX, cash: { creditTo, roundId: "0", token, amount: "1000000000" } };
}

const stream: AttemptedDeposit = { key: { BaseLog: { tx_hash: "ab".repeat(32), log_index: 3 } }, chain: "base", label: "Sablier stream #82", nearAccount: "alice.testnet", attemptedAt: 1, baseTx: `0x${"ab".repeat(32)}`, streamId: "82" };

describe("Base cash attempts", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("survive a reload: a cash deposit recorded after its receipt is listed again from localStorage", () => {
    recordAttempted(cash(5));
    recordAttempted(stream);
    expect(JSON.parse(store.get(ATTEMPTED_DEPOSITS_KEY) ?? "[]")).toHaveLength(2);
    const listed = cashAttempts(loadAttempted());
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ baseTx: TX, cash: { creditTo: "dao.sputnik-v2.testnet", roundId: "0", amount: "1000000000" } });
    forgetAttempted(cash(5).key);
    expect(cashAttempts(loadAttempted())).toEqual([]);
  });

  it("filter by venue token (any case) and by the credited account", () => {
    const list = [cash(1), cash(2, "alice.testnet"), cash(3, "alice.testnet", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"), stream];
    expect(cashAttempts(list, { token: TOKEN.toUpperCase().replace("0X", "0x") }).map((a) => a.cash.creditTo)).toEqual(["dao.sputnik-v2.testnet", "alice.testnet"]);
    expect(cashAttempts(list, { token: TOKEN, creditTo: "alice.testnet" })).toHaveLength(1);
    expect(cashAttempts(list, { creditTo: "alice.testnet" })).toHaveLength(2);
  });
});

describe("awaitsRegistration", () => {
  it("lists unregistered and in-flight logs, hides consumed and refused ones", () => {
    expect(awaitsRegistration(null, null)).toBe(true);
    expect(awaitsRegistration({ Pending: { since_block: 1 } }, null)).toBe(true);
    expect(awaitsRegistration("Consumed", null)).toBe(false);
    expect(awaitsRegistration(null, { reason: "x" })).toBe(false);
  });
});

describe("matchCashLog", () => {
  const key = cash(7).key;
  it("takes RoseVault's log at the recorded block-level index", () => {
    const logs = [
      { logIndex: 6, address: VAULT, id: "other index" },
      { logIndex: 7, address: "0x9999999999999999999999999999999999999999", id: "same index, other contract" },
      { logIndex: 7, address: VAULT.toUpperCase().replace("0X", "0x"), id: "vault" },
    ];
    expect(matchCashLog(logs, key, VAULT)?.id).toBe("vault");
  });
  it("finds nothing for another contract's log or a non-Base key", () => {
    expect(matchCashLog([{ logIndex: 7, address: "0x9999999999999999999999999999999999999999" }], key, VAULT)).toBeNull();
    expect(matchCashLog([{ logIndex: 7, address: VAULT }], { SolStream: { metadata: "m" } }, VAULT)).toBeNull();
  });
});
