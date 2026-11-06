import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Hex } from "viem";
import { roseVaultAbi } from "../../../../packages/sdk/src/chains/base/abis";
import { MOCK, type MockOverrides } from "./engine-mock";

/**
 * A Base cash deposit (`depositCash` on RoseVault) whose registration never ran: the tab was
 * closed during the finality wait. The browser record the app writes after the receipt, the
 * receipt itself with its `CashDeposited` log, a safe head far past it, and the engine's replay
 * state, which turns `Consumed` once `register_base_cash` is sent.
 */

export const CASH_TX = `0x${"5".repeat(64)}` as Hex;
const BLOCK_HASH = `0x${"6".repeat(64)}` as Hex;
const DEPOSIT_BLOCK = 39_000_000n;
const LOG_INDEX = 4;

const hex = (value: bigint | number): Hex => `0x${BigInt(value).toString(16)}`;

export type CashResume = { creditTo: string; amount: bigint; roundId: bigint; registered: boolean; registerSent: number };

/** The `rose.deposits.attempted` value recording the attempt exactly as `recordAttempted` stores it. */
export function cashAttemptJson(resume: CashResume): string {
  const attempt = {
    key: { BaseLog: { tx_hash: CASH_TX.slice(2), log_index: LOG_INDEX } },
    chain: "base",
    label: "depositCash of 1,000.00 tUSDC",
    nearAccount: resume.creditTo,
    attemptedAt: Date.now() - 600_000,
    baseTx: CASH_TX,
    cash: { creditTo: resume.creditTo, roundId: resume.roundId.toString(), token: MOCK.baseTusdc, amount: resume.amount.toString() },
  };
  return JSON.stringify([attempt]);
}

/** Init script writing `cashAttemptJson` before the page loads. */
export function cashAttemptScript(resume: CashResume): string {
  return `localStorage.setItem("rose.deposits.attempted", ${JSON.stringify(cashAttemptJson(resume))});`;
}

function receipt(resume: CashResume) {
  const event = getAbiItem({ abi: roseVaultAbi, name: "CashDeposited" });
  if (event.type !== "event") throw new Error("CashDeposited is not an event");
  const topics = encodeEventTopics({ abi: roseVaultAbi, eventName: "CashDeposited", args: { sender: MOCK.signer, token: MOCK.baseTusdc as Hex, roundId: resume.roundId } });
  const data = encodeAbiParameters(
    event.inputs.filter((input) => !input.indexed),
    [resume.creditTo, resume.amount, 1_762_199_400],
  );
  const log = { address: MOCK.vault, topics, data, blockNumber: hex(DEPOSIT_BLOCK), blockHash: BLOCK_HASH, transactionHash: CASH_TX, transactionIndex: "0x2", logIndex: hex(LOG_INDEX), removed: false };
  return { transactionHash: CASH_TX, blockNumber: hex(DEPOSIT_BLOCK), blockHash: BLOCK_HASH, transactionIndex: "0x2", from: MOCK.signer, to: MOCK.vault, status: "0x1", cumulativeGasUsed: "0x30d40", gasUsed: "0x30d40", effectiveGasPrice: "0x3b9aca00", contractAddress: null, type: "0x2", logs: [log], logsBloom: `0x${"0".repeat(512)}` };
}

function block(number: bigint) {
  return { number: hex(number), hash: BLOCK_HASH, parentHash: BLOCK_HASH, timestamp: hex(1_762_200_000), baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: MOCK.signer, nonce: "0x0000000000000000", transactions: [], logsBloom: `0x${"0".repeat(512)}`, difficulty: "0x0", extraData: "0x", size: "0x0", sha3Uncles: BLOCK_HASH, stateRoot: BLOCK_HASH, transactionsRoot: BLOCK_HASH, receiptsRoot: BLOCK_HASH, uncles: [], mixHash: BLOCK_HASH };
}

/** Wraps a spec's overrides with the Base receipt, the safe head and the replay key of the pending deposit. */
export function withCashResume(base: MockOverrides, resume: CashResume): MockOverrides {
  return {
    engineView: (method, args) => {
      if (method === "get_replay") return resume.registered ? "Consumed" : null;
      if (method === "get_refused_deposit") return null;
      return base.engineView?.(method, args);
    },
    nearRequest: (method, params) => {
      const result = base.nearRequest?.(method, params);
      if (method === "send_tx") {
        resume.registerSent += 1;
        resume.registered = true;
      }
      return result;
    },
    baseRequest: (method, params) => {
      if (method === "eth_getTransactionReceipt") return receipt(resume);
      if (method === "eth_getBlockByNumber") return block(params[0] === "safe" ? DEPOSIT_BLOCK + 1_000n : DEPOSIT_BLOCK + 1_010n);
      if (method === "eth_chainId") return "0x14a34";
      if (method === "eth_blockNumber") return hex(DEPOSIT_BLOCK + 1_010n);
      return base.baseRequest?.(method, params);
    },
    solanaRequest: base.solanaRequest,
  };
}
