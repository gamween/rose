import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  type DecodeErrorResultReturnType,
} from "viem";

export type EvmErrorKind = "rejected" | "insufficient_funds" | "reverted" | "rpc" | "unknown";

export interface ClassifiedEvmError {
  kind: EvmErrorKind;
  /** Human-readable sentence for the UI. */
  message: string;
  /** Name of the custom error when the call reverted with one. */
  revertName?: string;
  /** Decoded arguments of the custom error. */
  revertArgs?: readonly unknown[];
}

const CUSTOM_ERROR_MESSAGES: Record<string, (args: readonly unknown[]) => string> = {
  ZeroAddress: () => "An address argument was the zero address.",
  WrongLockup: ([lockup]) => `Stream from an unsupported lockup contract (${String(lockup)}); only the canonical Sablier Lockup is accepted.`,
  InvalidNearAccount: () => "The NEAR account id is not valid.",
  NotStreamOwner: ([streamId, owner]) => `You do not own stream ${String(streamId)} (owner ${String(owner)}).`,
  NotLockupLinear: ([streamId]) => `Stream ${String(streamId)} is not a Lockup Linear stream.`,
  StreamCancelable: ([streamId]) => `Stream ${String(streamId)} is cancelable; only non-cancelable streams can be deposited.`,
  StreamNotTransferable: ([streamId]) => `Stream ${String(streamId)} is not transferable.`,
  StreamCanceled: ([streamId]) => `Stream ${String(streamId)} was canceled.`,
  StreamDepleted: ([streamId]) => `Stream ${String(streamId)} is depleted: nothing is left to lock.`,
  StreamNotHeld: ([streamId]) => `Stream ${String(streamId)} is not held by RoseVault.`,
  UnexpectedNft: () => "RoseVault only accepts the stream it is depositing.",
  InsufficientFee: ([paid, required]) => `The Sablier withdrawal fee was not covered (paid ${String(paid)} wei, required ${String(required)} wei).`,
  RefundFailed: () => "Refunding the unused fee failed.",
  ZeroAmount: () => "The amount must be positive.",
  AmountMismatch: ([expected, received]) => `The token delivered ${String(received)} instead of ${String(expected)}; fee-on-transfer tokens are refused.`,
  NoDecimals: ([token]) => `Token ${String(token)} does not expose decimals().`,
  UnsupportedDecimals: ([decimals]) => `Token decimals ${String(decimals)} are not supported.`,
  AmountBelowMinimum: ([amount, minimum]) => `Amount ${String(amount)} is below the minimum of one whole token (${String(minimum)}).`,
  NoAllocations: () => "The cohort has no allocations.",
  TooManyAllocations: ([count]) => `Too many allocations (${String(count)}); the maximum is 50 per transaction.`,
  InvalidToken: ([token]) => `Token ${String(token)} is not valid for this cohort.`,
  InvalidSchedule: () => "The schedule is not valid (check start, cliff, end and unlock amounts).",
  AmountNotMultiple: ([index, amount, unit]) => `Allocation ${String(index)} (${String(amount)}) is not a multiple of the unit amount ${String(unit)}.`,
  AuthorizationUsed: ([id]) => `Authorization ${String(id)} was already executed.`,
  InvalidSignatureV: ([v]) => `Invalid signature v (${String(v)}); expected 27 or 28.`,
  InvalidSignatureS: () => "Invalid signature s (must be low).",
  InvalidSigner: ([recovered]) => `The signature was not produced by the engine's key (recovered ${String(recovered)}).`,
  MintCapExceeded: ([requested, available]) => `Mint cap reached: requested ${String(requested)}, ${String(available)} still available in this 24 h window.`,
  CooldownActive: ([availableAt]) => `You already minted this class; next mint at ${isoFromSeconds(availableAt)}.`,
  FaucetEmpty: ([balance, required]) => `The demo faucet is empty (balance ${String(balance)}, needs ${String(required)}).`,
  ScheduleEnded: ([cls]) => `The demo schedule of class ${String(cls)} has already ended.`,
  ERC20InsufficientBalance: ([, balance, needed]) => `Insufficient token balance (${String(balance)} available, ${String(needed)} needed).`,
  ERC20InsufficientAllowance: ([, allowance, needed]) => `Insufficient token allowance (${String(allowance)} approved, ${String(needed)} needed).`,
  ReentrancyGuardReentrantCall: () => "Reentrant call refused.",
  SafeERC20FailedOperation: ([token]) => `The token ${String(token)} refused the transfer.`,
};

function isoFromSeconds(value: unknown): string {
  if (typeof value !== "bigint" && typeof value !== "number") return String(value);
  return new Date(Number(value) * 1000).toISOString();
}

/** One sentence for a custom error of RoseVault, TestUSDC, DemoToken or DemoStreamFaucet. */
export function describeVaultError(errorName: string, args: readonly unknown[] = []): string {
  const describe = CUSTOM_ERROR_MESSAGES[errorName];
  return describe ? describe(args) : `The contract reverted with ${errorName}.`;
}

/** Maps a viem (or wallet) error to a kind the UI can act on and a readable sentence. */
export function classifyEvmError(error: unknown): ClassifiedEvmError {
  if (error instanceof BaseError) {
    const rejected = error.walk((cause) => cause instanceof UserRejectedRequestError);
    if (rejected) return { kind: "rejected", message: "The wallet rejected the request." };
    const funds = error.walk((cause) => cause instanceof InsufficientFundsError);
    if (funds) return { kind: "insufficient_funds", message: "Insufficient ETH on Base Sepolia to pay for gas and value." };
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const data: DecodeErrorResultReturnType | undefined = reverted.data;
      if (data) {
        const args = data.args ?? [];
        return { kind: "reverted", message: describeVaultError(data.errorName, args), revertName: data.errorName, revertArgs: args };
      }
      return { kind: "reverted", message: reverted.reason ?? "The contract reverted.", ...(reverted.reason ? { revertName: reverted.reason } : {}) };
    }
    if (/fetch|HTTP request failed|timeout|timed out|network/i.test(error.shortMessage)) {
      return { kind: "rpc", message: "The Base Sepolia RPC could not be reached. Retry in a moment." };
    }
    return { kind: "unknown", message: error.shortMessage };
  }
  if (error instanceof Error) {
    if (/user rejected|user denied|rejected the request/i.test(error.message)) {
      return { kind: "rejected", message: "The wallet rejected the request." };
    }
    return { kind: "unknown", message: error.message };
  }
  return { kind: "unknown", message: "Unknown error." };
}
