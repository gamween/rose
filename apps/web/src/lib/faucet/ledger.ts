/**
 * The faucet's durable memory is the chains themselves: there is no shared store on this
 * deployment, so the global caps count what each hot wallet actually sent, read from its own
 * on-chain history, and the per-address checks read the recipient's balance. Every reader fails
 * closed: an RPC error refuses the send instead of skipping the check.
 */

import type { Connection, PublicKey } from "@solana/web3.js";
import { DAY_SECONDS, HOUR_SECONDS, type SendUsage } from "./guards";

/** Blocks between the head and the sample used to measure the block time. */
const BLOCK_TIME_SAMPLE = 10_000;

function blocksBack(windowSeconds: number, lagSeconds: number, secondsPerBlock: number): number {
  return Math.max(0, Math.ceil((windowSeconds - lagSeconds) / secondsPerBlock));
}

/** The two reads of a viem public client the Base usage needs. */
export type BaseUsageClient = {
  getBlock(args: { blockTag: "latest" } | { blockNumber: bigint }): Promise<{ number: bigint | null; timestamp: bigint }>;
  getTransactionCount(args: { address: `0x${string}`; blockTag: "pending" } | { address: `0x${string}`; blockNumber: bigint }): Promise<number>;
};

/**
 * Transactions the Base hot wallet sent in the last hour and day: its pending nonce minus its
 * nonce at the block one window ago. The block time is measured on the chain (Base Sepolia runs
 * 0.2 s blocks), and the window start is rounded to an older block, so the count never undercounts.
 */
export async function readBaseUsage(client: BaseUsageClient, address: `0x${string}`, nowSeconds: number): Promise<SendUsage> {
  const head = await client.getBlock({ blockTag: "latest" });
  const headNumber = head.number;
  if (headNumber === null) throw new Error("The latest Base block has no number.");
  const sampleNumber = headNumber > BigInt(BLOCK_TIME_SAMPLE) ? headNumber - BigInt(BLOCK_TIME_SAMPLE) : 0n;
  const sample = await client.getBlock({ blockNumber: sampleNumber });
  const span = Number(head.timestamp - sample.timestamp);
  const blocks = Number(headNumber - sampleNumber);
  const lag = Math.max(0, nowSeconds - Number(head.timestamp));
  const at = (windowSeconds: number): bigint => {
    if (blocks <= 0 || span <= 0) return 0n;
    const back = BigInt(blocksBack(windowSeconds, lag, span / blocks));
    return headNumber > back ? headNumber - back : 0n;
  };
  const [pending, hourAgo, dayAgo] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "pending" }),
    client.getTransactionCount({ address, blockNumber: at(HOUR_SECONDS) }),
    client.getTransactionCount({ address, blockNumber: at(DAY_SECONDS) }),
  ]);
  return { lastHour: Math.max(0, pending - hourAgo), lastDay: Math.max(0, pending - dayAgo) };
}

export type SolanaUsageConnection = Pick<Connection, "getSignaturesForAddress">;

/**
 * Transactions touching the Solana hot wallet in the last hour and day, from its signature
 * history (`limit` newest). Refills count too, which only makes the cap stricter; a signature
 * without a block time counts as now.
 */
export async function readSolanaUsage(connection: SolanaUsageConnection, address: PublicKey, nowSeconds: number, limit: number): Promise<SendUsage> {
  const signatures = await connection.getSignaturesForAddress(address, { limit }, "confirmed");
  const times = signatures
    .map((signature) => signature.blockTime ?? nowSeconds)
    .filter((time) => time > nowSeconds - DAY_SECONDS)
    .sort((a, b) => a - b);
  return { lastHour: times.filter((time) => time > nowSeconds - HOUR_SECONDS).length, lastDay: times.length, times };
}

export class NearRpcCallError extends Error {
  constructor(
    readonly causeName: string,
    message: string,
  ) {
    super(message);
    this.name = "NearRpcCallError";
  }
}

export type NearRpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** A raw NEAR JSON-RPC call; an error answer throws with its `cause.name` (UNKNOWN_BLOCK, UNKNOWN_ACCOUNT…). */
export function nearRpcCall(url: string): NearRpcCall {
  return async (method, params) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "rose-faucet", method, params }) });
    if (!response.ok) throw new NearRpcCallError("HTTP", `NEAR RPC answered HTTP ${String(response.status)}`);
    const body = (await response.json()) as { result?: unknown; error?: { cause?: { name?: string }; message?: string; data?: unknown } };
    if (body.error) throw new NearRpcCallError(body.error.cause?.name ?? "UNKNOWN", typeof body.error.data === "string" ? body.error.data : (body.error.message ?? "NEAR RPC error"));
    return body.result;
  };
}

type BlockView = { header: { height: number; timestamp_nanosec: string } };
type AccessKeyView = { nonce?: number; error?: string };

/** Access key nonces start at `creation height × 1e6` and grow by one per signed transaction. */
const NONCE_RANGE = 1_000_000;
/** Heights with no block (skipped slots) are retried this many times, one height lower each time. */
const MISSING_BLOCK_RETRIES = 8;

async function blockAtOrBelow(call: NearRpcCall, height: number): Promise<BlockView> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await call("block", { block_id: height - attempt })) as BlockView;
    } catch (error) {
      if (!(error instanceof NearRpcCallError) || error.causeName !== "UNKNOWN_BLOCK" || attempt >= MISSING_BLOCK_RETRIES) throw error;
    }
  }
}

async function keyNonceAt(call: NearRpcCall, accountId: string, publicKey: string, blockId: number | "final"): Promise<number | null> {
  for (let attempt = 0; ; attempt += 1) {
    const where = blockId === "final" ? { finality: "final" } : { block_id: blockId - attempt };
    try {
      const view = (await call("query", { request_type: "view_access_key", account_id: accountId, public_key: publicKey, ...where })) as AccessKeyView;
      if (typeof view.nonce === "number") return view.nonce;
      if (view.error?.includes("does not exist")) return null;
      throw new NearRpcCallError("UNKNOWN", view.error ?? "view_access_key returned no nonce");
    } catch (error) {
      if (!(error instanceof NearRpcCallError)) throw error;
      if (error.causeName === "UNKNOWN_ACCESS_KEY") return null;
      if (error.causeName !== "UNKNOWN_BLOCK" || blockId === "final" || attempt >= MISSING_BLOCK_RETRIES) throw error;
    }
  }
}

/**
 * Transactions the NEAR funder key signed in the last hour and day: its nonce now minus its nonce
 * at the block one window ago (a key that did not exist then counts from its creation nonce).
 * Testnet RPC nodes keep about five epochs of state, more than a day.
 */
export async function readNearKeyUsage(call: NearRpcCall, accountId: string, publicKey: string, nowSeconds: number): Promise<SendUsage> {
  const head = (await call("block", { finality: "final" })) as BlockView;
  const sample = await blockAtOrBelow(call, head.header.height - BLOCK_TIME_SAMPLE);
  const seconds = (view: BlockView) => Number(BigInt(view.header.timestamp_nanosec) / 1_000_000_000n);
  const span = seconds(head) - seconds(sample);
  const blocks = head.header.height - sample.header.height;
  const secondsPerBlock = blocks > 0 && span > 0 ? span / blocks : 1;
  const lag = Math.max(0, nowSeconds - seconds(head));
  const now = await keyNonceAt(call, accountId, publicKey, "final");
  if (now === null) throw new NearRpcCallError("UNKNOWN_ACCESS_KEY", `The funder key is not an access key of ${accountId}.`);
  const since = async (windowSeconds: number) => {
    const height = Math.max(1, head.header.height - blocksBack(windowSeconds, lag, secondsPerBlock));
    const then = await keyNonceAt(call, accountId, publicKey, height);
    return now - (then ?? Math.floor(now / NONCE_RANGE) * NONCE_RANGE);
  };
  const [lastHour, lastDay] = await Promise.all([since(HOUR_SECONDS), since(DAY_SECONDS)]);
  return { lastHour, lastDay };
}

/** Whether a NEAR account exists at the final block. */
export async function nearAccountExists(call: NearRpcCall, accountId: string): Promise<boolean> {
  try {
    await call("query", { request_type: "view_account", account_id: accountId, finality: "final" });
    return true;
  } catch (error) {
    if (error instanceof NearRpcCallError && error.causeName === "UNKNOWN_ACCOUNT") return false;
    throw error;
  }
}
