import { readFileSync } from "node:fs";
import { formatTransactionReceipt, type PublicClient, type RpcTransactionReceipt, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { must } from "./must.js";
import { baseLogLocation, decodeCashDeposited, decodeStreamDeposited, registerBaseCashArgs, registerBaseDepositArgs, waitForSafeHead, type SafeHeadProgress } from "../../src/chains/base/deposit.js";

const fixture = (name: string): RpcTransactionReceipt => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as RpcTransactionReceipt;

/** Real receipts recorded on Base Sepolia on 2026-11-04 (docs/verification.md, "RoseVault spike"). */
const streamReceipt = formatTransactionReceipt(fixture("receipt_deposit_stream_82.json"));
const cashReceipt = formatTransactionReceipt(fixture("receipt_deposit_cash.json"));

/**
 * The prototype vault of the spike emitted `StreamDeposited` without the `decimals` field; the
 * engine vectors derive the production layout from the recorded log. This is that derived log
 * (contracts/engine/tests/vectors/foreign/evm_vault_logs.json, first entry).
 */
const derivedStreamLog = {
  address: "0x3985ddbbe8477dd42bd5e19f8726aae7a339b5e0",
  topics: [
    "0x588ce8ddd1a55c330cac56a02ed1423586edfcc762edb1db1b1f253dade6a599",
    "0x000000000000000000000000fa76b8f304d2a87fcaee0c258a76118368d0d671",
    "0x0000000000000000000000000000000000000000000000000000000000000052",
  ],
} as const;

describe("decodeCashDeposited", () => {
  it("decodes the real CashDeposited log with its block-level index", () => {
    const logs = decodeCashDeposited(cashReceipt);
    expect(logs).toHaveLength(1);
    const log = must(logs[0]);
    expect(log.logIndex).toBe(1);
    expect(log.transactionIndex).toBe(2);
    expect(log.blockNumber).toBe(54159306n);
    expect(log.args).toEqual({
      sender: "0xFa76B8f304d2A87FCAee0c258A76118368d0d671",
      token: "0xf8F5a4c21d80993Fa2fc9fe649f95384AB6dEc57",
      roundId: 1n,
      nearAccount: "rose-app.testnet",
      amount: 500_000_000n,
      timestamp: 1793753730,
    });
  });
});

describe("decodeStreamDeposited", () => {
  it("ignores logs of other contracts and layouts", () => {
    expect(decodeStreamDeposited(streamReceipt)).toEqual([]);
  });

  it("decodes a production-layout StreamDeposited log", () => {
    const vectors = JSON.parse(readFileSync(new URL("../../../../contracts/engine/tests/vectors/foreign/evm_vault_logs.json", import.meta.url), "utf8")) as {
      logs: { event: string; log: { data: `0x${string}` }; fields: Record<string, unknown> }[];
    };
    const entry = must(vectors.logs.find((log) => log.event === "StreamDeposited"));
    const base = must(streamReceipt.logs[2]);
    const receipt: TransactionReceipt = { ...streamReceipt, logs: [{ ...base, address: derivedStreamLog.address, topics: [...derivedStreamLog.topics], data: entry.log.data }] };
    const decoded = must(decodeStreamDeposited(receipt)[0]);
    expect(decoded.logIndex).toBe(2);
    expect(decoded.args.streamId).toBe(82n);
    expect(decoded.args.nearAccount).toBe("rose-app.testnet");
    expect(decoded.args.decimals).toBe(18);
    expect(decoded.args.deposited).toBe(BigInt(entry.fields["deposited"] as string));
    expect(decoded.args.cliffUnlock).toBe(25_000_000_000_000_000_000_000n);
    expect(decoded.args.granularity).toBe(1);
    expect(decoded.args.cancelable).toBe(false);
    expect(decoded.args.transferable).toBe(true);
    expect(decoded.args.timestamp).toBe(1793753725);
  });
});

describe("registerBaseDepositArgs", () => {
  it("encodes the fields exactly like the engine vector and the location with the block-level logIndex", () => {
    const vectors = JSON.parse(readFileSync(new URL("../../../../contracts/engine/tests/vectors/foreign/evm_vault_logs.json", import.meta.url), "utf8")) as {
      logs: { event: string; log: { data: `0x${string}` }; fields: Record<string, unknown> }[];
    };
    const entry = must(vectors.logs.find((log) => log.event === "StreamDeposited"));
    const base = must(streamReceipt.logs[2]);
    const receipt: TransactionReceipt = { ...streamReceipt, logs: [{ ...base, address: derivedStreamLog.address, topics: [...derivedStreamLog.topics], data: entry.log.data }] };
    const args = registerBaseDepositArgs(must(decodeStreamDeposited(receipt)[0]));
    expect(args.fields).toEqual(entry.fields);
    expect(args.location).toEqual({
      tx_hash: "0xcddf41ac9ba8c7b1a9053bc52e62c0edb4bbd4ab55752d817042aae34a35eeb2",
      block_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) as string,
      block_number: 54159281,
      transaction_index: 2,
      log_index: 2,
    });
  });

  it("builds cash registration arguments and refuses a pending log", () => {
    const cash = must(decodeCashDeposited(cashReceipt)[0]);
    const args = registerBaseCashArgs(cash);
    expect(args.location.log_index).toBe(1);
    expect(args.fields).toMatchObject({ round_id: 1, amount: "500000000", near_account: "rose-app.testnet", token: "0xf8f5a4c21d80993fa2fc9fe649f95384ab6dec57" });
    const pending = { ...must(cashReceipt.logs[1]), blockNumber: null, logIndex: null, transactionIndex: null, blockHash: null, transactionHash: null };
    expect(() => baseLogLocation(pending)).toThrow("not mined");
  });
});

describe("waitForSafeHead", () => {
  function clientWithSafeHeads(heads: bigint[]): PublicClient {
    let index = 0;
    return {
      getBlock: () => {
        const number = heads[Math.min(index, heads.length - 1)];
        index += 1;
        return Promise.resolve({ number });
      },
    } as unknown as PublicClient;
  }

  it("polls until the safe head passes the block, then waits the margin and reports every phase", async () => {
    const progress: SafeHeadProgress[] = [];
    const sleeps: number[] = [];
    const result = await waitForSafeHead(clientWithSafeHeads([54_159_200n, 54_159_250n, 54_159_300n]), 54_159_281n, {
      marginMs: 30_000,
      pollMs: 10_000,
      onProgress: (p) => progress.push(p),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ safeHead: 54_159_300n, target: 54_159_281n, phase: "ready" });
    expect(progress.map((p) => p.phase)).toEqual(["waiting_safe", "waiting_safe", "margin", "ready"]);
    expect(sleeps).toEqual([10_000, 10_000, 30_000]);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForSafeHead(clientWithSafeHeads([1n]), 10n, { signal: controller.signal, pollMs: 1 })).rejects.toThrow("aborted");
  });
});
