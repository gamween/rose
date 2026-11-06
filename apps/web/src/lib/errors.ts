/**
 * Human-readable errors for every async action (spec 8.3): wallet rejected, insufficient balance,
 * MPC timeout with retry, expired blockhash with retry, plus RPC and contract failures.
 */

import { BaseSafeHeadStalledError, NearRpcError, describeFailure } from "@rose/sdk";

export type ActionErrorKind =
  | "rejected"
  | "insufficient_balance"
  | "mpc_timeout"
  | "expired_blockhash"
  | "not_deployed"
  | "no_wallet"
  | "rate_limited"
  | "contract"
  | "rpc"
  | "unknown";

export type ActionError = {
  kind: ActionErrorKind;
  title: string;
  message: string;
  /** Whether retrying the same action makes sense (shown as a Retry button). */
  retryable: boolean;
};

export class RoseActionError extends Error implements ActionError {
  readonly kind: ActionErrorKind;
  readonly title: string;
  readonly retryable: boolean;

  constructor(kind: ActionErrorKind, title: string, message: string, retryable = false) {
    super(message);
    this.name = "RoseActionError";
    this.kind = kind;
    this.title = title;
    this.retryable = retryable;
  }
}

function text(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** EIP-1193 code 4001 only as an error code, never as digits inside an amount or an account id. */
const REJECTED = /user rejected|user denied|rejected the request|user cancel|cancelled by user|canceled by user|request rejected|action_rejected|\bcode"?\s*[:=]\s*4001\b/i;
const INSUFFICIENT = /insufficient funds|gas required exceeds allowance|insufficient lamports|insufficient balance|exceeds balance|not enough balance|attempt to debit an account|NotEnoughBalance|LackBalanceForState|Insufficient cash/i;
/** Solana's own expiry errors only: an engine panic that says "expired" is a contract error. */
const EXPIRED_BLOCKHASH = /blockhash not found|block height exceeded|TransactionExpired|BlockhashNotFound/i;
/**
 * The MPC network's own failures (a signature or CKD request that timed out, a yield that
 * resumed without a response, a callback's `PromiseError`), never the bare word "timeout": the
 * engine's "Key timeout reached" and "Key timeout not reached" are contract refusals.
 */
const MPC_TIMEOUT = /request has timed out|yield.*resumed|PromiseError/i;
const NETWORK = /fetch failed|Failed to fetch|NetworkError|ECONNREFUSED|ETIMEDOUT|TimeoutError|signal timed out|HTTP 5\d\d|\b429\b/i;

/**
 * OpenZeppelin v5 `IERC20Errors` selectors (`toFunctionSelector`, recorded in docs/verification.md).
 * The tokens' own reverts, which RoseVault's SafeERC20 bubbles up, are not in the vault ABI viem
 * decodes `depositCash`, `createStreams` and `depositStream` with, so viem only reports the raw data.
 */
const ERC20_INSUFFICIENT_BALANCE = "0xe450d38c";
const ERC20_INSUFFICIENT_ALLOWANCE = "0xfb8f41b2";

/** The raw revert data of a viem `ContractFunctionRevertedError` anywhere in the cause chain (viem is not imported here: every page loads this module). */
function revertData(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    const raw = (current as { raw?: unknown }).raw;
    if ((current as { name?: unknown }).name === "ContractFunctionRevertedError" && typeof raw === "string" && /^0x[0-9a-fA-F]*$/.test(raw)) return raw.toLowerCase();
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** `(address, uint256, uint256)` arguments of an `IERC20Errors` revert, or null when the data is not one. */
function erc20ErrorArgs(data: string, selector: string): { account: string; held: bigint; needed: bigint } | null {
  if (!data.startsWith(selector) || data.length < 10 + 3 * 64) return null;
  const word = (index: number) => data.slice(10 + index * 64, 10 + (index + 1) * 64);
  return { account: `0x${word(0).slice(24)}`, held: BigInt(`0x${word(1)}`), needed: BigInt(`0x${word(2)}`) };
}

/** A token's `ERC20InsufficientBalance` / `ERC20InsufficientAllowance` revert, in words. */
function erc20Revert(error: unknown): ActionError | null {
  const data = revertData(error);
  if (data === null) return null;
  const balance = erc20ErrorArgs(data, ERC20_INSUFFICIENT_BALANCE);
  if (balance) {
    return {
      kind: "insufficient_balance",
      title: "Not enough tokens",
      message: `${balance.account} holds ${balance.held.toString()} base units of the token and the transfer needs ${balance.needed.toString()}. Mint test tokens from "Get test funds", or lower the amount.`,
      retryable: false,
    };
  }
  const allowance = erc20ErrorArgs(data, ERC20_INSUFFICIENT_ALLOWANCE);
  if (allowance) {
    return {
      kind: "contract",
      title: "Allowance too low",
      message: `RoseVault (${allowance.account}) may pull ${allowance.held.toString()} base units of the token and the transfer needs ${allowance.needed.toString()}. Approve the amount again and retry.`,
      retryable: true,
    };
  }
  return null;
}

/** Maps anything thrown by a wallet, an RPC or a contract to a message a person can act on. */
export function toActionError(error: unknown): ActionError {
  if (error instanceof RoseActionError) return error;
  if (error instanceof BaseSafeHeadStalledError) return { kind: "rpc", title: "Base RPC stalled", message: error.message, retryable: true };
  const token = erc20Revert(error);
  if (token) return token;
  if (error instanceof NearRpcError) {
    if (error.kind === "account_missing") return { kind: "contract", title: "Account not found", message: error.message, retryable: false };
    if (error.kind === "no_contract" || error.kind === "method_missing") {
      return { kind: "not_deployed", title: "Contract not deployed", message: error.message, retryable: false };
    }
    if (error.kind === "unreachable" || error.kind === "http") {
      return { kind: "rpc", title: "NEAR RPC unreachable", message: "FastNEAR and the fallback RPC did not answer. Check your connection and retry.", retryable: true };
    }
    return describeContractMessage(error.message);
  }
  const raw = text(error);
  if (REJECTED.test(raw)) return { kind: "rejected", title: "Rejected in the wallet", message: "You rejected the request in your wallet. Nothing was sent.", retryable: true };
  if (MPC_TIMEOUT.test(raw)) {
    return {
      kind: "mpc_timeout",
      title: "MPC verification timed out",
      message:
        "The MPC nodes did not answer in time (about 2 minutes). Causes: the foreign transaction is not final yet, a wrong log index or values, or a lagging provider. Retry.",
      retryable: true,
    };
  }
  if (EXPIRED_BLOCKHASH.test(raw)) {
    return { kind: "expired_blockhash", title: "Blockhash expired", message: "The Solana blockhash expired before the transaction landed. Nothing was debited; retry with a fresh blockhash.", retryable: true };
  }
  if (INSUFFICIENT.test(raw)) return describeContractMessage(raw, "insufficient_balance");
  if (NETWORK.test(raw)) {
    return { kind: "rpc", title: "Network error", message: "The RPC did not answer. Check your connection and retry.", retryable: true };
  }
  const message = error instanceof Error ? error.message : raw;
  return describeContractMessage(message);
}

function describeContractMessage(message: string, forced?: ActionErrorKind): ActionError {
  const clean = message.replace(/^Smart contract panicked: /, "").replace(/^Error: /, "").trim();
  if (forced === "insufficient_balance" || INSUFFICIENT.test(clean)) {
    return {
      kind: "insufficient_balance",
      title: "Insufficient balance",
      message: /Insufficient cash/i.test(clean) ? "Your cash balance in the engine is too low for this order. Deposit tUSDC first." : "The account does not hold enough to pay for this transaction. Use \"Get test funds\".",
      retryable: false,
    };
  }
  return { kind: "contract", title: "Transaction failed", message: clean.length > 0 ? clean.slice(0, 300) : "The transaction failed.", retryable: false };
}

/** Error for a NEAR execution failure, from the outcome's `Failure` object. */
export function failureToActionError(failure: unknown): ActionError {
  return toActionError(new Error(describeFailure(failure)));
}
