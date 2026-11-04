import { base64ToBytes, bytesToUtf8, GAS } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { daoNearFundingCall, daoShortfall, ftTransferCall, sputnikProposal } from "./dao";
import { DAO_ACCOUNTS_KEY, forgetDaoAccount, isNearAccountId, readDaoAccounts, rememberDaoAccount, resultCreators } from "./dao-accounts";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("DAO funding proposal", () => {
  it("wraps the DAO's ft_transfer_call into the engine as a Sputnik FunctionCall with 1 yocto and explicit gas", () => {
    const call = daoNearFundingCall("tusdc.rose-app.testnet", "engine-s4.rose-app.testnet", 1_003_000_000n);
    const proposal = sputnikProposal(call, "fund");
    const action = proposal.proposal.kind.FunctionCall.actions[0]!;
    expect(proposal.proposal.kind.FunctionCall.receiver_id).toBe("tusdc.rose-app.testnet");
    expect(action.method_name).toBe("ft_transfer_call");
    expect(action.deposit).toBe("1");
    expect(action.gas).toBe(GAS.ftTransferCall.toString());
    /* The engine accepts only an empty msg and credits the sender, the DAO. */
    expect(JSON.parse(bytesToUtf8(base64ToBytes(action.args)))).toEqual({ receiver_id: "engine-s4.rose-app.testnet", amount: "1003000000", msg: "" });
  });

  it("sends tUSDC to the DAO with ft_transfer and computes the shortfall", () => {
    expect(ftTransferCall("tusdc.rose-app.testnet", "dao.sputnik-v2.testnet", 5n, "memo")).toEqual({ receiverId: "tusdc.rose-app.testnet", methodName: "ft_transfer", args: { receiver_id: "dao.sputnik-v2.testnet", amount: "5", memo: "memo" }, gas: GAS.simple, deposit: 1n });
    expect(daoShortfall(1_003_000_000n, 0n)).toBe(1_003_000_000n);
    expect(daoShortfall(1_003_000_000n, 3_000_000n)).toBe(1_000_000_000n);
    expect(daoShortfall(1_003_000_000n, 2_000_000_000n)).toBe(0n);
  });
});

describe("remembered DAO accounts", () => {
  it("keeps valid ids, most recent first, at most eight, and forgets one", () => {
    const storage = new MemoryStorage();
    expect(readDaoAccounts(storage)).toEqual([]);
    rememberDaoAccount("a.sputnik-v2.testnet", storage);
    rememberDaoAccount("b.sputnik-v2.testnet", storage);
    expect(rememberDaoAccount("a.sputnik-v2.testnet", storage)).toEqual(["a.sputnik-v2.testnet", "b.sputnik-v2.testnet"]);
    expect(rememberDaoAccount("Not An Account", storage)).toEqual(["a.sputnik-v2.testnet", "b.sputnik-v2.testnet"]);
    for (let i = 0; i < 10; i += 1) rememberDaoAccount(`dao${String(i)}.testnet`, storage);
    expect(readDaoAccounts(storage)).toHaveLength(8);
    expect(forgetDaoAccount("dao9.testnet", storage)).not.toContain("dao9.testnet");
  });

  it("ignores a corrupted entry", () => {
    const storage = new MemoryStorage();
    storage.setItem(DAO_ACCOUNTS_KEY, "{oops");
    expect(readDaoAccounts(storage)).toEqual([]);
    storage.setItem(DAO_ACCOUNTS_KEY, JSON.stringify(["ok.testnet", 3, "BAD"]));
    expect(readDaoAccounts(storage)).toEqual(["ok.testnet"]);
  });

  it("validates NEAR account ids", () => {
    expect(isNearAccountId("treasury.sputnik-v2.testnet")).toBe(true);
    expect(isNearAccountId("rose-demo-a4001b.testnet")).toBe(true);
    expect(isNearAccountId("a")).toBe(false);
    expect(isNearAccountId("Upper.testnet")).toBe(false);
    expect(isNearAccountId("double..dot")).toBe(false);
  });
});

describe("Results tab creators", () => {
  it("lists the connected account first and each DAO once", () => {
    expect(resultCreators("me.testnet", ["dao.testnet", "me.testnet"])).toEqual(["me.testnet", "dao.testnet"]);
    expect(resultCreators(null, ["dao.testnet"])).toEqual(["dao.testnet"]);
  });
});
