import { bytesToHex } from "../../encoding.js";
import type { Connection } from "@solana/web3.js";
import { NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey, SystemProgram, Transaction, type Commitment } from "@solana/web3.js";

/** Size of a System nonce account (`nonce::State::size()`, 80 bytes). */
export const NONCE_ACCOUNT_LEN: number = NONCE_ACCOUNT_LENGTH;

/** Rent-exempt balance of a nonce account, read live (1,056,640 lamports measured on devnet). */
export function nonceRent(connection: Connection): Promise<number> {
  return connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LEN);
}

/** Hex characters of `sha256(accountId)` every payout nonce seed of a NEAR account starts with (engine `nonce_seed_prefix_of`). */
export const NONCE_SEED_PREFIX_LEN = 24;
/** Longest Solana seed (`MAX_SEED_LEN`, 32 bytes): a payout nonce seed adds at most 8 characters after the prefix. */
export const MAX_SEED_LEN = 32;

/**
 * The prefix binding a payout nonce account to `accountId` (spec 7.3): the engine accepts a
 * nonce account only when its address is `createWithSeed(base, seed, SystemProgram)` with a
 * seed starting with the caller's prefix, so nobody else can spend its nonce values.
 */
export async function nonceSeedPrefix(accountId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountId)));
  return bytesToHex(digest).slice(0, NONCE_SEED_PREFIX_LEN);
}

/** Seed of a payout nonce account of `accountId`: its prefix, then `suffix` (at most 8 ASCII characters, so one wallet can hold several). */
export async function payoutNonceSeed(accountId: string, suffix = ""): Promise<string> {
  if (suffix.length + NONCE_SEED_PREFIX_LEN > MAX_SEED_LEN || !/^[\x20-\x7e]*$/.test(suffix)) throw new Error(`A nonce seed suffix is at most ${String(MAX_SEED_LEN - NONCE_SEED_PREFIX_LEN)} ASCII characters.`);
  return (await nonceSeedPrefix(accountId)) + suffix;
}

/** Address of the nonce account created from `base` with `seed` (`PublicKey.createWithSeed` under the System program). */
export function payoutNonceAddress(base: PublicKey, seed: string): Promise<PublicKey> {
  return PublicKey.createWithSeed(base, seed, SystemProgram.programId);
}

export interface CreateNonceAccountParams {
  /** Pays the rent and the fee, and is the base the address is derived from: it is the only signer. */
  payer: PublicKey;
  /** `payoutNonceAddress(payer, seed)`. */
  nonceAccount: PublicKey;
  /** `payoutNonceSeed(accountId, suffix)` of the NEAR account that will claim with it. */
  seed: string;
  /** `vault/sol` for a payout nonce (spec 7.3). */
  authority: PublicKey;
  lamports: number;
  /** From `getLatestBlockhash`. */
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Transaction creating a payout's durable nonce account with a seed (`SystemProgram.createNonceAccount` with `basePubkey` = payer); the payer signs alone. */
export function createNonceAccountTransaction(params: CreateNonceAccountParams): Transaction {
  const transaction = new Transaction({ blockhash: params.blockhash, lastValidBlockHeight: params.lastValidBlockHeight, feePayer: params.payer });
  transaction.add(
    SystemProgram.createNonceAccount({
      fromPubkey: params.payer,
      noncePubkey: params.nonceAccount,
      basePubkey: params.payer,
      seed: params.seed,
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
