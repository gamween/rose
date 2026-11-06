import { base64ToBytes } from "../../encoding.js";
import type { Connection, Signer, SignatureStatus, Transaction } from "@solana/web3.js";
import { SendTransactionError, type Commitment, type TransactionSignature } from "@solana/web3.js";

/** Broadcasts a fully signed transaction (wire bytes or base64) and returns its signature. */
export function broadcastSignedTransaction(connection: Connection, wire: Uint8Array | string, options: { skipPreflight?: boolean } = {}): Promise<TransactionSignature> {
  const bytes = typeof wire === "string" ? base64ToBytes(wire) : wire;
  return connection.sendRawTransaction(bytes, { skipPreflight: options.skipPreflight ?? false });
}

/**
 * When a blockhash-based transaction can no longer land: the blockhash it was built on and the
 * last block height at which that blockhash is valid (both from `getLatestBlockhash`).
 */
export interface ConfirmOptions {
  strategy: "blockhash";
  blockhash: string;
  lastValidBlockHeight: number;
  /** Status the signature must reach (default `confirmed`). */
  commitment?: Commitment;
  /** Milliseconds between two polls (default 2,000). */
  intervalMs?: number;
  signal?: AbortSignal;
}

export class SolanaTransactionError extends Error {
  readonly signature: string;
  readonly transactionError: unknown;

  constructor(signature: string, transactionError: unknown) {
    super(`Transaction ${signature} failed: ${JSON.stringify(transactionError)}`);
    this.name = "SolanaTransactionError";
    this.signature = signature;
    this.transactionError = transactionError;
  }
}

/** A transaction never seen on chain before its blockhash expired: it can no longer land, and nothing was debited. */
export class SolanaBlockhashExpiredError extends Error {
  readonly signature: string;

  constructor(signature: string, blockhash: string, lastValidBlockHeight: number) {
    super(`Signature ${signature} has expired: block height exceeded ${String(lastValidBlockHeight)} (blockhash ${blockhash}) and the transaction was never seen.`);
    this.name = "SolanaBlockhashExpiredError";
    this.signature = signature;
  }
}

/** 0 for processed, 1 for confirmed, 2 for finalized (web3.js's deprecated aliases included). */
function rank(commitment: Commitment | undefined): number {
  switch (commitment) {
    case "processed":
    case "recent":
      return 0;
    case "finalized":
    case "max":
    case "root":
      return 2;
    case "confirmed":
    case "single":
    case "singleGossip":
    case undefined:
      return 1;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readStatus(connection: Connection, signature: TransactionSignature): Promise<SignatureStatus | null> {
  const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  return value[0] ?? null;
}

/**
 * Waits for a blockhash-based transaction over HTTP only: polls `getSignatureStatuses` (with the
 * transaction history) until the signature reaches `commitment`, and gives up only once the
 * cluster's confirmed block height has passed `lastValidBlockHeight` with the signature still
 * unseen on a last read. No websocket subscription, so a devnet websocket outage cannot turn a
 * landed transaction into a false expiry. Returns the final status; throws
 * `SolanaTransactionError` when the transaction landed with an error, and
 * `SolanaBlockhashExpiredError` when it can no longer land.
 */
export async function waitForSignature(connection: Connection, signature: TransactionSignature, options: ConfirmOptions): Promise<SignatureStatus> {
  const wanted = rank(options.commitment);
  const interval = options.intervalMs ?? 2_000;
  for (;;) {
    const status = await readStatus(connection, signature);
    if (status?.err) throw new SolanaTransactionError(signature, status.err);
    if (status && rank(status.confirmationStatus ?? "processed") >= wanted) return status;
    if (!status) {
      const height = await connection.getBlockHeight("confirmed");
      if (height > options.lastValidBlockHeight) {
        const last = await readStatus(connection, signature);
        if (!last) throw new SolanaBlockhashExpiredError(signature, options.blockhash, options.lastValidBlockHeight);
        continue;
      }
    }
    await sleep(interval, options.signal);
  }
}

/** Waits for a signature (see `waitForSignature`); throws `SolanaTransactionError` when it failed on chain. */
export async function confirmSignature(connection: Connection, signature: TransactionSignature, options: ConfirmOptions): Promise<void> {
  await waitForSignature(connection, signature, options);
}

/**
 * Signs a legacy transaction with a fresh blockhash (the first signer pays the fee unless
 * `feePayer` is set), sends it with preflight and waits for it with `waitForSignature`: the
 * websocket-free replacement of web3.js `sendAndConfirmTransaction`. Returns the signature.
 */
export async function sendAndConfirmLegacyTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: [Signer, ...Signer[]],
  options: { commitment?: Commitment; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<TransactionSignature> {
  const commitment = options.commitment ?? "confirmed";
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer ??= signers[0].publicKey;
  transaction.sign(...signers);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: commitment });
  await waitForSignature(connection, signature, { strategy: "blockhash", blockhash, lastValidBlockHeight, commitment, ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }), ...(options.signal ? { signal: options.signal } : {}) });
  return signature;
}

export type SolanaErrorKind = "expired_blockhash" | "insufficient_funds" | "rejected" | "already_processed" | "unknown";

export interface ClassifiedSolanaError { kind: SolanaErrorKind; message: string }

function errorText(error: unknown): string {
  if (error instanceof SendTransactionError) return `${error.message} ${error.transactionError.message} ${error.logs?.join(" ") ?? ""}`;
  if (error instanceof SolanaTransactionError) return JSON.stringify(error.transactionError);
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Maps a web3.js or wallet-adapter error to a kind the UI can act on and a readable sentence. */
export function classifySolanaError(error: unknown): ClassifiedSolanaError {
  const text = errorText(error);
  if (/user rejected|user denied|rejected the request|WalletSignTransactionError|Transaction rejected/i.test(text)) {
    return { kind: "rejected", message: "The wallet rejected the request." };
  }
  if (/blockhash not found|block height exceeded|BlockhashNotFound|TransactionExpiredBlockheightExceeded|has expired/i.test(text)) {
    return { kind: "expired_blockhash", message: "The transaction's blockhash expired before it landed. Retry with a fresh blockhash." };
  }
  if (/insufficient lamports|Attempt to debit an account but found no record of a prior credit|insufficient funds|InsufficientFundsForFee|InsufficientFundsForRent/i.test(text)) {
    return { kind: "insufficient_funds", message: "Insufficient SOL on devnet to pay the fee or the rent." };
  }
  if (/AlreadyProcessed|already been processed/i.test(text)) {
    return { kind: "already_processed", message: "This transaction was already processed." };
  }
  return { kind: "unknown", message: error instanceof Error ? error.message : "Unknown Solana error." };
}
