import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { nearAccountExists, NearRpcCallError, readBaseUsage, readNearKeyUsage, readSolanaUsage, type BaseUsageClient, type NearRpcCall, type SolanaUsageConnection } from "./ledger";

const NOW = 1_800_000_000;
const HOT = "0xe87366B9a546D8F1B30631a20F8F079eb85dc59e";

describe("readBaseUsage", () => {
  /** A chain with 0.2 s blocks whose head is at NOW; the nonce grew by one at each listed block. */
  function chain(head: bigint, sendBlocks: bigint[], pendingExtra = 0): BaseUsageClient & { asked: bigint[] } {
    const asked: bigint[] = [];
    const timestamp = (block: bigint) => BigInt(NOW) - (head - block) / 5n;
    return {
      asked,
      getBlock: async (args) => ("blockTag" in args ? { number: head, timestamp: timestamp(head) } : { number: args.blockNumber, timestamp: timestamp(args.blockNumber) }),
      getTransactionCount: async (args) => {
        if ("blockTag" in args) return sendBlocks.length + pendingExtra;
        asked.push(args.blockNumber);
        return sendBlocks.filter((block) => block <= args.blockNumber).length;
      },
    };
  }

  it("counts the sends of the last hour and day from the nonce at the window starts", async () => {
    const head = 50_000_000n;
    /* 18,000 blocks per hour at 0.2 s. */
    const sends = [head - 500_000n, head - 400_000n, head - 20_000n, head - 17_000n, head - 10n];
    const client = chain(head, sends, 1);
    const usage = await readBaseUsage(client, HOT, NOW);
    expect(usage).toEqual({ lastHour: 3, lastDay: 5 });
    expect(client.asked).toEqual([head - 18_000n, head - 432_000n]);
  });

  it("falls back to the whole history when the block time cannot be measured", async () => {
    const client: BaseUsageClient = {
      getBlock: async () => ({ number: 10n, timestamp: BigInt(NOW) }),
      getTransactionCount: async (args) => ("blockTag" in args ? 4 : 0),
    };
    expect(await readBaseUsage(client, HOT, NOW)).toEqual({ lastHour: 4, lastDay: 4 });
  });
});

describe("readSolanaUsage", () => {
  it("counts signatures inside each window and returns their times oldest first", async () => {
    let askedLimit = 0;
    const connection = {
      getSignaturesForAddress: async (_address: PublicKey, options?: { limit?: number }) => {
        askedLimit = options?.limit ?? 0;
        return [{ blockTime: NOW - 100 }, { blockTime: null }, { blockTime: NOW - 5_000 }, { blockTime: NOW - 90_000 }];
      },
    } as unknown as SolanaUsageConnection;
    const usage = await readSolanaUsage(connection, new PublicKey("DJgWSMB3D8sKyJNoQJqsCKpD4H4c3tm2NhG9EXumnzxV"), NOW, 7);
    expect(askedLimit).toBe(7);
    expect(usage).toEqual({ lastHour: 2, lastDay: 3, times: [NOW - 5_000, NOW - 100, NOW] });
  });
});

describe("readNearKeyUsage", () => {
  const ACCOUNT = "rose-faucet.testnet";
  const KEY = "ed25519:2yRriwq22j53TJgXvhGzE1ANyGrTAAwoMa4fu3VGUAec";
  const HEAD = 276_204_164;
  const CREATED = 276_151_044;

  /** 0.5 s blocks; `missing` heights have no block; the key exists from CREATED with one nonce per listed send height. */
  function rpc(sends: number[], missing: number[] = []): NearRpcCall & { heights: number[] } {
    const heights: number[] = [];
    const time = (height: number) => String(BigInt(NOW - (HEAD - height) / 2) * 1_000_000_000n);
    const call = async (method: string, params: Record<string, unknown>) => {
      const height = typeof params.block_id === "number" ? params.block_id : HEAD;
      if (missing.includes(height)) throw new NearRpcCallError("UNKNOWN_BLOCK", "DB Not Found Error: BLOCK HEIGHT");
      if (method === "block") return { header: { height, timestamp_nanosec: time(height) } };
      if (params.request_type === "view_access_key") {
        heights.push(height);
        if (height < CREATED) return { error: `access key ${KEY} does not exist while viewing`, logs: [] };
        return { nonce: CREATED * 1_000_000 + sends.filter((send) => send <= height).length };
      }
      throw new Error(`unexpected ${method}`);
    };
    return Object.assign(call, { heights });
  }

  it("counts the nonces signed in each window, skipping heights without a block", async () => {
    const call = rpc([HEAD - 50_000, HEAD - 6_000, HEAD - 100, HEAD - 5], [HEAD - 7_200, HEAD - 7_201]);
    const usage = await readNearKeyUsage(call, ACCOUNT, KEY, NOW);
    expect(usage.lastHour).toBe(3);
    /* The key was created inside the day window: everything since its creation nonce counts. */
    expect(usage.lastDay).toBe(4);
    expect(call.heights).toContain(HEAD - 7_202);
  });

  it("refuses a funder key that is not an access key of the account", async () => {
    const call: NearRpcCall = async (method) => {
      if (method === "block") return { header: { height: HEAD, timestamp_nanosec: String(BigInt(NOW) * 1_000_000_000n) } };
      throw new NearRpcCallError("UNKNOWN_ACCESS_KEY", "missing");
    };
    await expect(readNearKeyUsage(call, ACCOUNT, KEY, NOW)).rejects.toThrow(/not an access key/);
  });
});

describe("nearAccountExists", () => {
  it("reads UNKNOWN_ACCOUNT as absent and rethrows other errors", async () => {
    expect(await nearAccountExists(async () => ({ amount: "1" }), "a.testnet")).toBe(true);
    expect(await nearAccountExists(() => Promise.reject(new NearRpcCallError("UNKNOWN_ACCOUNT", "no")), "a.testnet")).toBe(false);
    await expect(nearAccountExists(() => Promise.reject(new NearRpcCallError("HTTP", "down")), "a.testnet")).rejects.toThrow("down");
  });
});
