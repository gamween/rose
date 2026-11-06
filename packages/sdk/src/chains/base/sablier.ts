import {
  encodeFunctionData,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { sablierLockupAbi } from "./abis.js";
import { SABLIER_LOCKUP_V4 } from "./client.js";

/** Minimal ERC-20 ABI (metadata, balances, approvals and the TestUSDC public mint). */
export const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;

/**
 * Lockup methods the vault interface does not declare but which exist in the deployed v4 runtime
 * (selectors checked in the bytecode: `nextStreamId` 0x1e99d569, `getRefundedAmount` 0xd4dbd20b;
 * see docs/verification.md).
 */
export const sablierLockupExtrasAbi = [
  { type: "function", name: "nextStreamId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "getRefundedAmount",
    stateMutability: "view",
    inputs: [{ name: "streamId", type: "uint256" }],
    outputs: [{ name: "refundedAmount", type: "uint128" }],
  },
] as const;

/** `Lockup.Model` of `contracts/evm/src/interfaces/ISablierLockup.sol`. */
export const LockupModel = { LINEAR: 0, DYNAMIC: 1, TRANCHED: 2, PRICE_GATED: 3 } as const;

export interface SablierStream {
  streamId: bigint;
  owner: Address;
  token: Address;
  decimals: number;
  deposited: bigint;
  withdrawn: bigint;
  refunded: bigint;
  start: number;
  cliff: number;
  end: number;
  granularity: number;
  unlockAmounts: { start: bigint; cliff: bigint };
  cancelable: boolean;
  transferable: boolean;
  wasCanceled: boolean;
  isDepleted: boolean;
  lockupModel: number;
  withdrawable: bigint;
}

/** A viem wallet client with its chain and account bound (injected wallet or in-app demo key). */
export type SignerClient = WalletClient<Transport, Chain, Account>;

function lockupContract(lockup: Address) {
  return { address: lockup, abi: sablierLockupAbi } as const;
}

function hasMulticall(client: PublicClient): boolean {
  return Boolean(client.chain?.contracts?.multicall3);
}

/** Reads every field of one Lockup stream (multicall when the chain declares Multicall3). */
export async function readStream(client: PublicClient, streamId: bigint, lockup: Address = SABLIER_LOCKUP_V4): Promise<SablierStream> {
  const c = lockupContract(lockup);
  const reads = {
    owner: { ...c, functionName: "ownerOf", args: [streamId] },
    token: { ...c, functionName: "getUnderlyingToken", args: [streamId] },
    deposited: { ...c, functionName: "getDepositedAmount", args: [streamId] },
    withdrawn: { ...c, functionName: "getWithdrawnAmount", args: [streamId] },
    refunded: { address: lockup, abi: sablierLockupExtrasAbi, functionName: "getRefundedAmount", args: [streamId] },
    start: { ...c, functionName: "getStartTime", args: [streamId] },
    cliff: { ...c, functionName: "getCliffTime", args: [streamId] },
    end: { ...c, functionName: "getEndTime", args: [streamId] },
    granularity: { ...c, functionName: "getGranularity", args: [streamId] },
    unlock: { ...c, functionName: "getUnlockAmounts", args: [streamId] },
    cancelable: { ...c, functionName: "isCancelable", args: [streamId] },
    transferable: { ...c, functionName: "isTransferable", args: [streamId] },
    wasCanceled: { ...c, functionName: "wasCanceled", args: [streamId] },
    isDepleted: { ...c, functionName: "isDepleted", args: [streamId] },
    model: { ...c, functionName: "getLockupModel", args: [streamId] },
    withdrawable: { ...c, functionName: "withdrawableAmountOf", args: [streamId] },
  } as const;
  const keys = Object.keys(reads) as (keyof typeof reads)[];
  const contracts = keys.map((key) => reads[key]);
  const values: unknown[] = hasMulticall(client)
    ? await client.multicall({ contracts, allowFailure: false })
    : await sequential(client, contracts);
  const at = (key: keyof typeof reads): unknown => values[keys.indexOf(key)];
  const token = at("token") as Address;
  const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  const unlock = at("unlock") as { start: bigint; cliff: bigint };
  return {
    streamId,
    owner: at("owner") as Address,
    token,
    decimals,
    deposited: at("deposited") as bigint,
    withdrawn: at("withdrawn") as bigint,
    refunded: at("refunded") as bigint,
    start: Number(at("start")),
    cliff: Number(at("cliff")),
    end: Number(at("end")),
    granularity: Number(at("granularity")),
    unlockAmounts: { start: unlock.start, cliff: unlock.cliff },
    cancelable: at("cancelable") as boolean,
    transferable: at("transferable") as boolean,
    wasCanceled: at("wasCanceled") as boolean,
    isDepleted: at("isDepleted") as boolean,
    lockupModel: Number(at("model")),
    withdrawable: at("withdrawable") as bigint,
  };
}

async function sequential(client: PublicClient, contracts: readonly Parameters<PublicClient["readContract"]>[0][]): Promise<unknown[]> {
  const values: unknown[] = [];
  for (const contract of contracts) values.push(await client.readContract(contract));
  return values;
}

export interface ListOwnedStreamsOptions {
  /** Lowest stream id scanned (inclusive). Defaults to `toId - 199`. */
  fromId?: bigint;
  /** Highest stream id scanned (inclusive). Defaults to `nextStreamId - 1`. */
  toId?: bigint;
  /** Ids per multicall batch. */
  batchSize?: number;
  lockup?: Address;
}

/**
 * Ids of the Lockup streams owned by `owner` in a bounded id range (the Lockup NFT is not
 * enumerable), scanning `ownerOf` from the newest id backwards. Burned or unknown ids are skipped.
 */
export async function listOwnedStreams(client: PublicClient, owner: Address, options: ListOwnedStreamsOptions = {}): Promise<bigint[]> {
  const lockup = options.lockup ?? SABLIER_LOCKUP_V4;
  const toId = options.toId ?? (await client.readContract({ address: lockup, abi: sablierLockupExtrasAbi, functionName: "nextStreamId" })) - 1n;
  const fromId = options.fromId ?? (toId >= 199n ? toId - 199n : 1n);
  const batchSize = BigInt(options.batchSize ?? 100);
  const wanted = owner.toLowerCase();
  const found: bigint[] = [];
  for (let high = toId; high >= fromId; high -= batchSize) {
    const low = high - batchSize + 1n > fromId ? high - batchSize + 1n : fromId;
    const ids: bigint[] = [];
    for (let id = high; id >= low; id -= 1n) ids.push(id);
    const contracts = ids.map((id) => ({ ...lockupContract(lockup), functionName: "ownerOf" as const, args: [id] as const }));
    const results = hasMulticall(client)
      ? await client.multicall({ contracts, allowFailure: true })
      : await Promise.all(contracts.map((contract) => client.readContract(contract).then((result) => ({ status: "success" as const, result }), (error: unknown) => ({ status: "failure" as const, error }))));
    results.forEach((result, index) => {
      const id = ids[index];
      if (id !== undefined && result.status === "success" && result.result.toLowerCase() === wanted) found.push(id);
    });
  }
  return found;
}

export type EligibilityReason =
  | "not_linear"
  | "cancelable"
  | "not_transferable"
  | "canceled"
  | "depleted"
  | "below_minimum";

export interface Eligibility { eligible: boolean; reasons: EligibilityReason[] }

/** Spec 7.1 eligibility of a stream for `depositStream`. `minimumDeposit` defaults to one whole token. */
export function checkEligibility(stream: SablierStream, options: { minimumDeposit?: bigint } = {}): Eligibility {
  const reasons: EligibilityReason[] = [];
  if (stream.lockupModel !== LockupModel.LINEAR) reasons.push("not_linear");
  if (stream.cancelable) reasons.push("cancelable");
  if (!stream.transferable) reasons.push("not_transferable");
  if (stream.wasCanceled) reasons.push("canceled");
  if (stream.isDepleted) reasons.push("depleted");
  const minimum = options.minimumDeposit ?? 10n ** BigInt(stream.decimals);
  const remaining = stream.deposited - stream.withdrawn - stream.withdrawable;
  if (stream.deposited < minimum || remaining < minimum) reasons.push("below_minimum");
  return { eligible: reasons.length === 0, reasons };
}

export const ELIGIBILITY_MESSAGES: Record<EligibilityReason, string> = {
  not_linear: "Only Lockup Linear streams can be deposited.",
  cancelable: "The stream is cancelable; the sender must renounce it first.",
  not_transferable: "The stream is not transferable.",
  canceled: "The stream was canceled.",
  depleted: "The stream is depleted; nothing is left to lock.",
  below_minimum: "Less than one whole token would remain locked after the vested part is withdrawn.",
};

/** Current Sablier withdrawal fee for the stream (0 today on Base Sepolia, admin-controlled). */
export function calculateMinFeeWei(client: PublicClient, streamId: bigint, lockup: Address = SABLIER_LOCKUP_V4): Promise<bigint> {
  return client.readContract({ ...lockupContract(lockup), functionName: "calculateMinFeeWei", args: [streamId] });
}

/** Calldata of `withdrawMax(streamId, to)`. */
export function withdrawMaxCalldata(streamId: bigint, to: Address): Hex {
  return encodeFunctionData({ abi: sablierLockupAbi, functionName: "withdrawMax", args: [streamId, to] });
}

/** The address currently approved for one stream NFT (`getApproved`), the zero address when none. */
export function approvedFor(client: PublicClient, streamId: bigint, lockup: Address = SABLIER_LOCKUP_V4): Promise<Address> {
  return client.readContract({ ...lockupContract(lockup), functionName: "getApproved", args: [streamId] });
}

/** Approves `spender` (RoseVault) for one stream NFT. */
export function approveStream(wallet: SignerClient, streamId: bigint, spender: Address, lockup: Address = SABLIER_LOCKUP_V4): Promise<Hex> {
  return wallet.writeContract({ ...lockupContract(lockup), functionName: "approve", args: [spender, streamId] });
}

/**
 * `withdrawMax(streamId, to)`: allowed for anyone when `to` is the stream's recipient (spec 7.3).
 * `value` pays Sablier's withdrawal fee and defaults to 0, enough while the fee is 0 (live today);
 * otherwise pass `calculateMinFeeWei` plus a margin.
 */
export function withdrawMax(wallet: SignerClient, streamId: bigint, to: Address, options: { lockup?: Address; value?: bigint } = {}): Promise<Hex> {
  return wallet.writeContract({
    ...lockupContract(options.lockup ?? SABLIER_LOCKUP_V4),
    functionName: "withdrawMax",
    args: [streamId, to],
    value: options.value ?? 0n,
  });
}
