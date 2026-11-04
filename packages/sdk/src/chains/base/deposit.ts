import { decodeEventLog, type Address, type Hex, type Log, type PublicClient, type TransactionReceipt } from "viem";
import { roseVaultAbi } from "./abis.js";

/** A `StreamDeposited` log decoded with its position in the block. */
export interface StreamDepositedLog {
  /** Block-level log index: viem's `Log.logIndex` is "index of this log within its block", the value the MPC `Log` extractor matches (spec 7.1). */
  logIndex: number;
  transactionIndex: number;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  address: Address;
  args: {
    sender: Address;
    nearAccount: string;
    lockup: Address;
    streamId: bigint;
    token: Address;
    decimals: number;
    deposited: bigint;
    withdrawn: bigint;
    start: number;
    cliff: number;
    end: number;
    granularity: number;
    startUnlock: bigint;
    cliffUnlock: bigint;
    cancelable: boolean;
    transferable: boolean;
    timestamp: number;
  };
  raw: Log;
}

export type CashDepositedLog = Omit<StreamDepositedLog, "args"> & {
  args: { sender: Address; token: Address; roundId: bigint; nearAccount: string; amount: bigint; timestamp: number };
};

type MinedLog = Log<bigint, number, false>;

function isMined(log: Log): log is MinedLog {
  return log.blockNumber !== null && log.logIndex !== null && log.transactionIndex !== null && log.blockHash !== null && log.transactionHash !== null;
}

function location(log: MinedLog): Omit<StreamDepositedLog, "args" | "raw"> {
  return {
    logIndex: log.logIndex,
    transactionIndex: log.transactionIndex,
    transactionHash: log.transactionHash,
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    address: log.address,
  };
}

/** Every `StreamDeposited` log of a receipt (one per holder for `createStreams`). */
export function decodeStreamDeposited(receipt: TransactionReceipt): StreamDepositedLog[] {
  const found: StreamDepositedLog[] = [];
  for (const log of receipt.logs) {
    if (!isMined(log)) continue;
    try {
      const decoded = decodeEventLog({ abi: roseVaultAbi, eventName: "StreamDeposited", topics: log.topics, data: log.data, strict: true });
      found.push({ ...location(log), args: { ...decoded.args }, raw: log });
    } catch {
      continue;
    }
  }
  return found;
}

/** Every `CashDeposited` log of a receipt. */
export function decodeCashDeposited(receipt: TransactionReceipt): CashDepositedLog[] {
  const found: CashDepositedLog[] = [];
  for (const log of receipt.logs) {
    if (!isMined(log)) continue;
    try {
      const decoded = decodeEventLog({ abi: roseVaultAbi, eventName: "CashDeposited", topics: log.topics, data: log.data, strict: true });
      found.push({ ...location(log), args: { ...decoded.args }, raw: log });
    } catch {
      continue;
    }
  }
  return found;
}

export type SafeHeadPhase = "waiting_safe" | "margin" | "ready";
export interface SafeHeadProgress { safeHead: bigint; target: bigint; phase: SafeHeadPhase }

export interface WaitForSafeHeadOptions {
  /** Extra wait after the safe head passed, because the MPC nodes' own providers can lag the public RPC (spec 7.1: about 30 s). */
  marginMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: SafeHeadProgress) => void;
  /** Injectable clock for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolves once Base's `safe` head has passed `blockNumber` plus `marginMs` (spec 7.1 step 3:
 * the engine verifies with finality `Safe`). Observed: the safe head jumps every 3 to 4 minutes.
 */
export async function waitForSafeHead(client: PublicClient, blockNumber: bigint, options: WaitForSafeHeadOptions = {}): Promise<SafeHeadProgress> {
  const marginMs = options.marginMs ?? 30_000;
  const pollMs = options.pollMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  let safeHead: bigint;
  for (;;) {
    const block = await client.getBlock({ blockTag: "safe" });
    safeHead = block.number;
    if (safeHead >= blockNumber) break;
    options.onProgress?.({ safeHead, target: blockNumber, phase: "waiting_safe" });
    await sleep(pollMs, options.signal);
  }
  options.onProgress?.({ safeHead, target: blockNumber, phase: "margin" });
  await sleep(marginMs, options.signal);
  const done: SafeHeadProgress = { safeHead, target: blockNumber, phase: "ready" };
  options.onProgress?.(done);
  return done;
}

/** `BaseLogLocation` of the engine's `register_base_deposit` / `register_base_cash` (hashes as `0x` + lowercase hex). */
export interface BaseLogLocation {
  tx_hash: Hex;
  block_hash: Hex;
  block_number: number;
  transaction_index: number;
  /** Block-level `logIndex` of the receipt log, what the MPC `Log` extractor matches. */
  log_index: number;
}

/** `StreamDepositedFields` of `register_base_deposit`: addresses `0x` lowercase, u128 amounts as strings, u64 as numbers. */
export interface StreamDepositedFields {
  sender: string;
  stream_id: number;
  near_account: string;
  lockup: string;
  token: string;
  decimals: number;
  deposited: string;
  withdrawn: string;
  start: number;
  cliff: number;
  end: number;
  granularity: number;
  start_unlock: string;
  cliff_unlock: string;
  cancelable: boolean;
  transferable: boolean;
  timestamp: number;
}

/** `CashDepositedFields` of `register_base_cash`. */
export interface CashDepositedFields {
  sender: string;
  token: string;
  round_id: number;
  near_account: string;
  amount: string;
  timestamp: number;
}

export interface RegisterBaseDepositArgs {
  location: BaseLogLocation;
  fields: StreamDepositedFields;
}

export interface RegisterBaseCashArgs {
  location: BaseLogLocation;
  fields: CashDepositedFields;
}

function lower(value: Hex): Hex {
  return value.toLowerCase() as Hex;
}

/** The on-chain location of a mined receipt log, as the engine's `BaseLogLocation`. Throws on a pending log. */
export function baseLogLocation(log: Log | StreamDepositedLog | CashDepositedLog): BaseLogLocation {
  const raw = "raw" in log ? log.raw : log;
  if (!isMined(raw)) throw new Error("The log is not mined yet.");
  return {
    tx_hash: lower(raw.transactionHash),
    block_hash: lower(raw.blockHash),
    block_number: Number(raw.blockNumber),
    transaction_index: raw.transactionIndex,
    log_index: raw.logIndex,
  };
}

function u64(value: bigint | number, field: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${field} does not fit in a JSON number.`);
  return n;
}

/**
 * Builds the engine's `register_base_deposit(location, fields)` arguments from a decoded
 * `StreamDeposited` log (spec 7.1 step 3). The engine rebuilds the log from `fields`, verifies it
 * through the MPC and compares the hash with its own recomputation.
 */
export function registerBaseDepositArgs(log: StreamDepositedLog): RegisterBaseDepositArgs {
  const a = log.args;
  return {
    location: baseLogLocation(log),
    fields: {
      sender: lower(a.sender),
      stream_id: u64(a.streamId, "streamId"),
      near_account: a.nearAccount,
      lockup: lower(a.lockup),
      token: lower(a.token),
      decimals: a.decimals,
      deposited: a.deposited.toString(),
      withdrawn: a.withdrawn.toString(),
      start: a.start,
      cliff: a.cliff,
      end: a.end,
      granularity: a.granularity,
      start_unlock: a.startUnlock.toString(),
      cliff_unlock: a.cliffUnlock.toString(),
      cancelable: a.cancelable,
      transferable: a.transferable,
      timestamp: a.timestamp,
    },
  };
}

/** Builds the engine's `register_base_cash(location, fields)` arguments from a decoded `CashDeposited` log. */
export function registerBaseCashArgs(log: CashDepositedLog): RegisterBaseCashArgs {
  const a = log.args;
  return {
    location: baseLogLocation(log),
    fields: { sender: lower(a.sender), token: lower(a.token), round_id: u64(a.roundId, "roundId"), near_account: a.nearAccount, amount: a.amount.toString(), timestamp: a.timestamp },
  };
}
