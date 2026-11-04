import { decodeEventLog, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { demoStreamFaucetAbi, roseVaultAbi, testUsdcAbi } from "./abis.js";
import { calculateMinFeeWei, erc20Abi, type SignerClient } from "./sablier.js";

/** `DemoStreamFaucet.Class`. */
export const DemoClass = { SEED: 0, KOL: 1 } as const;
export type DemoClassIndex = (typeof DemoClass)[keyof typeof DemoClass];

export interface DepositStreamParams {
  vault: Address;
  streamId: bigint;
  nearAccount: string;
  /** Extra wei sent above `calculateMinFeeWei` (the fee is oracle-based and can move between blocks); refunded by the vault. */
  feeMarginWei?: bigint;
  lockup?: Address;
}

export interface DepositStreamResult { hash: Hex; minFeeWei: bigint; value: bigint }

/** `RoseVault.depositStream`: reads the Sablier fee in the same flow and sends it plus the margin. */
export async function depositStream(wallet: SignerClient, client: PublicClient, params: DepositStreamParams): Promise<DepositStreamResult> {
  const lockup = params.lockup ?? (await client.readContract({ address: params.vault, abi: roseVaultAbi, functionName: "LOCKUP" }));
  const minFeeWei = await calculateMinFeeWei(client, params.streamId, lockup);
  const value = minFeeWei + (params.feeMarginWei ?? 0n);
  const { request } = await client.simulateContract({
    account: wallet.account,
    address: params.vault,
    abi: roseVaultAbi,
    functionName: "depositStream",
    args: [lockup, params.streamId, params.nearAccount],
    value,
  });
  const hash = await wallet.writeContract(request);
  return { hash, minFeeWei, value };
}

export interface CohortSchedule {
  start: number;
  cliff: number;
  end: number;
  granularity: number;
  unitAmount: bigint;
  unitStartUnlock: bigint;
  unitCliffUnlock: bigint;
}

export interface Allocation { nearAccount: string; amount: bigint }

export interface CreateStreamsParams {
  vault: Address;
  token: Address;
  schedule: CohortSchedule;
  allocations: Allocation[];
  /** Wei forwarded for Sablier's withdrawal fee when the schedule already started (the vault withdraws the vested part to the issuer); the unused part is refunded. */
  value?: bigint;
}

/** `RoseVault.createStreams` (issuer path): one transaction, one `StreamDeposited` per holder. The caller must have approved the vault for the total. */
export function createStreams(wallet: SignerClient, params: CreateStreamsParams): Promise<Hex> {
  return wallet.writeContract({
    address: params.vault,
    abi: roseVaultAbi,
    functionName: "createStreams",
    args: [params.token, params.schedule, params.allocations],
    value: params.value ?? 0n,
  });
}

/** Total amount `createStreams` pulls from the issuer. */
export function cohortTotal(allocations: readonly Allocation[]): bigint {
  return allocations.reduce((sum, allocation) => sum + allocation.amount, 0n);
}

export interface DepositCashParams { vault: Address; token: Address; amount: bigint; nearAccount: string; roundId: bigint }

/** `RoseVault.depositCash`: the caller must have approved the vault for `amount`. */
export function depositCash(wallet: SignerClient, params: DepositCashParams): Promise<Hex> {
  return wallet.writeContract({
    address: params.vault,
    abi: roseVaultAbi,
    functionName: "depositCash",
    args: [params.token, params.amount, params.nearAccount, params.roundId],
  });
}

/** ERC-20 approval of `spender` for `amount`. */
export function approveToken(wallet: SignerClient, token: Address, spender: Address, amount: bigint): Promise<Hex> {
  return wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
}

export interface TransferAuthorization { token: Address; to: Address; amount: bigint; id: bigint }
export interface ReleaseAuthorization { lockup: Address; streamId: bigint; to: Address; id: bigint }
export interface Eip712Signature { v: number; r: Hex; s: Hex }

/** Submits an engine-signed `Transfer` authorization (anyone can; the caller pays gas). */
export function executeTransfer(wallet: SignerClient, params: { vault: Address; authorization: TransferAuthorization } & Eip712Signature): Promise<Hex> {
  return wallet.writeContract({
    address: params.vault,
    abi: roseVaultAbi,
    functionName: "executeTransfer",
    args: [params.authorization, params.v, params.r, params.s],
  });
}

/** Submits an engine-signed `Release` authorization (in-kind redeem). */
export function executeRelease(wallet: SignerClient, params: { vault: Address; authorization: ReleaseAuthorization } & Eip712Signature): Promise<Hex> {
  return wallet.writeContract({
    address: params.vault,
    abi: roseVaultAbi,
    functionName: "executeRelease",
    args: [params.authorization, params.v, params.r, params.s],
  });
}

/** Whether the authorization id was consumed in RoseVault's replay bitmap. */
export function isAuthorizationUsed(client: PublicClient, vault: Address, id: bigint): Promise<boolean> {
  return client.readContract({ address: vault, abi: roseVaultAbi, functionName: "isAuthorizationUsed", args: [id] });
}

/** `TestUSDC.mint(amount)`: public mint capped at 10,000 tUSDC per address per rolling 24 h. */
export function mintTestUsdc(wallet: SignerClient, token: Address, amount: bigint): Promise<Hex> {
  return wallet.writeContract({ address: token, abi: testUsdcAbi, functionName: "mint", args: [amount] });
}

/** Amount `account` can still mint in its current window. */
export function mintableAmount(client: PublicClient, token: Address, account: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: testUsdcAbi, functionName: "mintableAmount", args: [account] });
}

/** `DemoStreamFaucet.mintPosition(class)`: a Sablier LL stream of the demo token to the caller, one per class per 24 h. */
export function mintDemoPosition(wallet: SignerClient, faucet: Address, classIndex: DemoClassIndex): Promise<Hex> {
  return wallet.writeContract({ address: faucet, abi: demoStreamFaucetAbi, functionName: "mintPosition", args: [classIndex] });
}

/** Stream id from the `PositionMinted` log of a `mintPosition` receipt. */
export function decodePositionMinted(receipt: TransactionReceipt): { recipient: Address; classIndex: number; streamId: bigint } | null {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: demoStreamFaucetAbi, eventName: "PositionMinted", topics: log.topics, data: log.data });
      return { recipient: decoded.args.recipient, classIndex: decoded.args.class, streamId: decoded.args.streamId };
    } catch {
      continue;
    }
  }
  return null;
}

export interface DemoSchedule { start: number; cliff: number; end: number; amount: bigint; startUnlock: bigint; cliffUnlock: bigint }

/** Schedule the faucet uses for a class. */
export async function demoFaucetSchedule(client: PublicClient, faucet: Address, classIndex: DemoClassIndex): Promise<DemoSchedule> {
  const schedule = await client.readContract({ address: faucet, abi: demoStreamFaucetAbi, functionName: "scheduleOf", args: [classIndex] });
  return {
    start: schedule.start,
    cliff: schedule.cliff,
    end: schedule.end,
    amount: schedule.amount,
    startUnlock: schedule.startUnlock,
    cliffUnlock: schedule.cliffUnlock,
  };
}

/** Unix seconds of the account's last mint for the class (0 when never). */
export function lastMintAt(client: PublicClient, faucet: Address, account: Address, classIndex: DemoClassIndex): Promise<bigint> {
  return client.readContract({ address: faucet, abi: demoStreamFaucetAbi, functionName: "lastMintAt", args: [account, classIndex] });
}

/** ERC-20 balance. */
export function tokenBalance(client: PublicClient, token: Address, account: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}
