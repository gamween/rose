import { base64ToBytes } from "../../encoding.js";
import type { Connection, PublicKey} from "@solana/web3.js";
import { SendTransactionError, type Commitment, type TransactionSignature } from "@solana/web3.js";

/** Broadcasts a fully signed transaction (wire bytes or base64) and returns its signature. */
export function broadcastSignedTransaction(connection: Connection, wire: Uint8Array | string, options: { skipPreflight?: boolean } = {}): Promise<TransactionSignature> {
  const bytes = typeof wire === "string" ? base64ToBytes(wire) : wire;
  return connection.sendRawTransaction(bytes, { skipPreflight: options.skipPreflight ?? false });
}

export type ConfirmOptions =
  | {
      strategy: "blockhash";
      blockhash: string;
      lastValidBlockHeight: number;
      commitment?: Commitment;
    }
  | {
      strategy: "durable-nonce";
      nonceAccount: PublicKey;
      /** Nonce value the transaction was built on; confirmation ends when the account advances past it. */
      nonceValue: string;
      /** Slot at which `nonceValue` was read. */
      minContextSlot: number;
      commitment?: Commitment;
    };

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

/** Waits for a signature with the matching web3.js confirmation strategy; throws `SolanaTransactionError` when it failed on chain. */
export async function confirmSignature(connection: Connection, signature: TransactionSignature, options: ConfirmOptions): Promise<void> {
  const commitment = options.commitment ?? "confirmed";
  let failure: unknown;
  try {
    const result =
      options.strategy === "blockhash"
        ? await connection.confirmTransaction({ signature, blockhash: options.blockhash, lastValidBlockHeight: options.lastValidBlockHeight }, commitment)
        : await connection.confirmTransaction(
            { signature, nonceAccountPubkey: options.nonceAccount, nonceValue: options.nonceValue, minContextSlot: options.minContextSlot },
            commitment,
          );
    failure = result.value.err;
  } catch (error) {
    // web3.js rejects with the raw `TransactionError` object when the signature landed with an error.
    if (error instanceof Error) throw error;
    failure = error;
  }
  if (failure !== null) throw new SolanaTransactionError(signature, failure);
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
