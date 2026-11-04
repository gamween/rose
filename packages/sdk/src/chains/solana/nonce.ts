import { bytesToHex } from "../../encoding.js";
import type { Connection, PublicKey } from "@solana/web3.js";
import { NONCE_ACCOUNT_LENGTH, NonceAccount, SystemProgram, Transaction, type Commitment } from "@solana/web3.js";

/** Size of a System nonce account (`nonce::State::size()`, 80 bytes). */
export const NONCE_ACCOUNT_LEN: number = NONCE_ACCOUNT_LENGTH;

/** Rent-exempt balance of a nonce account, read live (1,056,640 lamports measured on devnet). */
export function nonceRent(connection: Connection): Promise<number> {
  return connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LEN);
}

export interface CreateNonceAccountParams {
  /** Pays the rent and the fee, and signs with the new nonce account's keypair. */
  payer: PublicKey;
  nonceAccount: PublicKey;
  /** `vault/sol` for a payout nonce (spec 7.3). */
  authority: PublicKey;
  lamports: number;
  /** From `getLatestBlockhash`. */
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Transaction creating a durable nonce account (`SystemProgram.createNonceAccount`); sign with the payer and the nonce keypair. */
export function createNonceAccountTransaction(params: CreateNonceAccountParams): Transaction {
  const transaction = new Transaction({ blockhash: params.blockhash, lastValidBlockHeight: params.lastValidBlockHeight, feePayer: params.payer });
  transaction.add(
    SystemProgram.createNonceAccount({
      fromPubkey: params.payer,
      noncePubkey: params.nonceAccount,
      authorizedPubkey: params.authority,
      lamports: params.lamports,
    }),
  );
  return transaction;
}

export interface NonceAccountState {
  authority: PublicKey;
  /** Current nonce value (a blockhash-shaped base58 string). */
  nonce: string;
  feeCalculator: { lamportsPerSignature: number };
  /** The exact bytes read, for the engine's `AccountState` proof. */
  raw: Uint8Array;
  owner: PublicKey;
  slot: number;
}

/** Reads and decodes a nonce account (`NonceAccount.fromAccountData`). */
export async function readNonceAccount(connection: Connection, pubkey: PublicKey, commitment: Commitment = "finalized"): Promise<NonceAccountState> {
  const response = await connection.getAccountInfoAndContext(pubkey, commitment);
  const info = response.value;
  if (!info) throw new Error(`Nonce account ${pubkey.toBase58()} does not exist.`);
  if (info.data.length !== NONCE_ACCOUNT_LEN) throw new Error(`Nonce account ${pubkey.toBase58()} has ${String(info.data.length)} bytes, expected ${String(NONCE_ACCOUNT_LEN)}.`);
  const decoded = NonceAccount.fromAccountData(info.data);
  return {
    authority: decoded.authorizedPubkey,
    nonce: decoded.nonce,
    feeCalculator: { lamportsPerSignature: decoded.feeCalculator.lamportsPerSignature },
    raw: Uint8Array.from(info.data),
    owner: info.owner,
    slot: response.context.slot,
  };
}

/** `SvmAccount` JSON of `foreign::mpc`: `owner` is a `Bytes32` (lowercase hex, no `0x`), `data` lowercase hex (`hex_vec`). */
export interface AccountStateArgs { owner: string; data: string }

/** Encodes raw account bytes the way the engine's `AccountState` proof arguments expect them. */
export function accountStateArgs(owner: PublicKey, raw: Uint8Array): AccountStateArgs {
  return { owner: bytesToHex(owner.toBytes()), data: bytesToHex(raw) };
}

/** Owner and bytes of a nonce account for the engine's proof before signing a payout. */
export function nonceAccountStateArgs(state: NonceAccountState): AccountStateArgs {
  return accountStateArgs(state.owner, state.raw);
}
