/**
 * Human-readable errors for every async action (spec 8.3): wallet rejected, insufficient balance,
 * MPC timeout with retry, expired blockhash with retry, plus RPC and contract failures.
 */

import { NearRpcError, describeFailure } from "@rose/sdk";

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

const REJECTED = /user rejected|user denied|rejected the request|user cancel|cancelled by user|canceled by user|request rejected|action_rejected|4001/i;
const INSUFFICIENT = /insufficient funds|insufficient lamports|insufficient balance|exceeds balance|not enough balance|attempt to debit an account|NotEnoughBalance|LackBalanceForState|Insufficient cash/i;
const EXPIRED_BLOCKHASH = /blockhash not found|block height exceeded|transaction has expired|expired|BlockhashNotFound/i;
const MPC_TIMEOUT = /request has timed out|timed out|Timeout|yield.*resumed|PromiseError/i;

/** Maps anything thrown by a wallet, an RPC or a contract to a message a person can act on. */
export function toActionError(error: unknown): ActionError {
  if (error instanceof RoseActionError) return error;
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
  if (/fetch failed|Failed to fetch|NetworkError|ECONNREFUSED|ETIMEDOUT|HTTP 5\d\d|429/i.test(raw)) {
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
