import { Buffer } from "buffer";
import type {
  Connection} from "@solana/web3.js";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  type Commitment,
} from "@solana/web3.js";
import { STREAMFLOW_DEVNET_PROGRAM } from "./client.js";

/** `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (classic SPL Token; Token-2022 is not modeled). */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Size of a Streamflow metadata account (`METADATA_LEN`). */
export const STREAMFLOW_METADATA_LEN = 1104;

/** `sha256("global:transfer_recipient")[..8]` (same constant as `foreign::solana` in the engine). */
export const STREAMFLOW_TRANSFER_RECIPIENT_DISCRIMINATOR = Uint8Array.from([0xeb, 0xf6, 0xe0, 0x40, 0x69, 0xa6, 0x14, 0x8a]);

/** Offset of `recipient` in the metadata account (used by `getProgramAccounts` memcmp). */
export const STREAMFLOW_RECIPIENT_OFFSET = 113;

/**
 * Streamflow stream metadata, decoded with exactly the offsets of
 * `contracts/engine/src/foreign/solana.rs` (`StreamflowMetadata::parse`): little-endian, no
 * discriminator, 1,104 bytes; `magic` 0, `version` 8, `created_at` 9, `amount_withdrawn` 17,
 * `canceled_at` 25, `end_time` 33, `last_withdrawn_at` 41, `sender` 49, `sender_tokens` 81,
 * `recipient` 113, `recipient_tokens` 145, `mint` 177, `escrow_tokens` 209, `streamflow_treasury`
 * 241, `streamflow_treasury_tokens` 273, `partner` 325, `partner_tokens` 357, `start_time` 409,
 * `net_amount_deposited` 417, `period` 425, `amount_per_period` 433, `cliff` 441, `cliff_amount`
 * 449, `cancelable_by_sender` 457, `cancelable_by_recipient` 458, `automatic_withdrawal` 459,
 * `transferable_by_sender` 460, `transferable_by_recipient` 461, `can_topup` 462,
 * `withdraw_frequency` 527, `pausable` 539, `can_update_rate` 540, `closed` 671,
 * `current_pause_start` 672, `pause_cumulative` 680, `last_rate_change_time` 688,
 * `funds_unlocked_at_last_rate_change` 696.
 */
export interface StreamflowMetadata {
  magic: bigint;
  version: number;
  createdAt: bigint;
  amountWithdrawn: bigint;
  canceledAt: bigint;
  endTime: bigint;
  lastWithdrawnAt: bigint;
  sender: PublicKey;
  senderTokens: PublicKey;
  recipient: PublicKey;
  recipientTokens: PublicKey;
  mint: PublicKey;
  escrowTokens: PublicKey;
  streamflowTreasury: PublicKey;
  streamflowTreasuryTokens: PublicKey;
  partner: PublicKey;
  partnerTokens: PublicKey;
  streamflowFeeTotal: bigint;
  streamflowFeeWithdrawn: bigint;
  /** `streamflow_fee_percent`: the raw bits of the `f32`, compared as bits as the engine does (`-0.0` is a fee). */
  streamflowFeePercentBits: number;
  partnerFeeTotal: bigint;
  partnerFeeWithdrawn: bigint;
  /** `partner_fee_percent`: the raw bits of the `f32`. */
  partnerFeePercentBits: number;
  startTime: bigint;
  netAmountDeposited: bigint;
  period: bigint;
  amountPerPeriod: bigint;
  cliff: bigint;
  cliffAmount: bigint;
  cancelableBySender: boolean;
  cancelableByRecipient: boolean;
  automaticWithdrawal: boolean;
  transferableBySender: boolean;
  transferableByRecipient: boolean;
  canTopup: boolean;
  withdrawFrequency: bigint;
  pausable: boolean;
  canUpdateRate: boolean;
  closed: boolean;
  currentPauseStart: bigint;
  pauseCumulative: bigint;
  lastRateChangeTime: bigint;
  fundsUnlockedAtLastRateChange: bigint;
}

export class StreamflowDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamflowDecodeError";
  }
}

/** Decodes a 1,104-byte Streamflow metadata account. */
export function decodeStreamflowMetadata(bytes: Uint8Array): StreamflowMetadata {
  if (bytes.length !== STREAMFLOW_METADATA_LEN) {
    throw new StreamflowDecodeError(`Expected ${String(STREAMFLOW_METADATA_LEN)} bytes, got ${String(bytes.length)}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (offset: number): bigint => view.getBigUint64(offset, true);
  const key = (offset: number): PublicKey => new PublicKey(bytes.subarray(offset, offset + 32));
  const flag = (offset: number): boolean => {
    const value = bytes[offset];
    if (value !== 0 && value !== 1) throw new StreamflowDecodeError(`Flag at offset ${String(offset)} is ${String(value)}.`);
    return value === 1;
  };
  return {
    magic: u64(0),
    version: bytes[8] ?? 0,
    createdAt: u64(9),
    amountWithdrawn: u64(17),
    canceledAt: u64(25),
    endTime: u64(33),
    lastWithdrawnAt: u64(41),
    sender: key(49),
    senderTokens: key(81),
    recipient: key(113),
    recipientTokens: key(145),
    mint: key(177),
    escrowTokens: key(209),
    streamflowTreasury: key(241),
    streamflowTreasuryTokens: key(273),
    partner: key(325),
    partnerTokens: key(357),
    streamflowFeeTotal: u64(305),
    streamflowFeeWithdrawn: u64(313),
    streamflowFeePercentBits: view.getUint32(321, true),
    partnerFeeTotal: u64(389),
    partnerFeeWithdrawn: u64(397),
    partnerFeePercentBits: view.getUint32(405, true),
    startTime: u64(409),
    netAmountDeposited: u64(417),
    period: u64(425),
    amountPerPeriod: u64(433),
    cliff: u64(441),
    cliffAmount: u64(449),
    cancelableBySender: flag(457),
    cancelableByRecipient: flag(458),
    automaticWithdrawal: flag(459),
    transferableBySender: flag(460),
    transferableByRecipient: flag(461),
    canTopup: flag(462),
    withdrawFrequency: u64(527),
    pausable: flag(539),
    canUpdateRate: flag(540),
    closed: flag(671),
    currentPauseStart: u64(672),
    pauseCumulative: u64(680),
    lastRateChangeTime: u64(688),
    fundsUnlockedAtLastRateChange: u64(696),
  };
}

export interface StreamflowStreamState {
  metadata: StreamflowMetadata;
  /** The exact bytes read, to pass to `register_sol_deposit` (spec 7.2 step 3). */
  raw: Uint8Array;
  owner: PublicKey;
  slot: number;
}

/** Reads one stream's metadata account (default `finalized`, the commitment the engine proves). */
export async function readStreamflowStream(connection: Connection, metadataPubkey: PublicKey, commitment: Commitment = "finalized"): Promise<StreamflowStreamState> {
  const response = await connection.getAccountInfoAndContext(metadataPubkey, commitment);
  const info = response.value;
  if (!info) throw new StreamflowDecodeError(`Account ${metadataPubkey.toBase58()} does not exist.`);
  const raw = Uint8Array.from(info.data);
  return { metadata: decodeStreamflowMetadata(raw), raw, owner: info.owner, slot: response.context.slot };
}

export interface StreamflowStreamListing { metadataPubkey: PublicKey; metadata: StreamflowMetadata; raw: Uint8Array }

/** Streams whose current recipient is `recipient` (`getProgramAccounts`, memcmp at offset 113, dataSize 1104). */
export async function listStreamflowStreamsForRecipient(
  connection: Connection,
  recipient: PublicKey,
  options: { program?: PublicKey; commitment?: Commitment } = {},
): Promise<StreamflowStreamListing[]> {
  const accounts = await connection.getProgramAccounts(options.program ?? STREAMFLOW_DEVNET_PROGRAM, {
    commitment: options.commitment ?? "confirmed",
    filters: [{ dataSize: STREAMFLOW_METADATA_LEN }, { memcmp: { offset: STREAMFLOW_RECIPIENT_OFFSET, bytes: recipient.toBase58() } }],
  });
  return accounts.map(({ pubkey, account }) => {
    const raw = Uint8Array.from(account.data);
    return { metadataPubkey: pubkey, metadata: decodeStreamflowMetadata(raw), raw };
  });
}

export type StreamflowEligibilityReason =
  | "closed"
  | "canceled"
  | "cancelable_by_sender"
  | "transferable_by_sender"
  | "not_transferable_by_recipient"
  | "pausable"
  | "can_update_rate"
  | "can_topup"
  | "automatic_withdrawal"
  | "modified"
  | "fees"
  | "ends_too_soon";

export interface StreamflowEligibility { eligible: boolean; reasons: StreamflowEligibilityReason[] }

/** Seconds before its `end_time` a stream must still be when it is attributed (the engine's `DEPOSIT_END_MARGIN_SECS`, spec 7.2). */
export const DEPOSIT_END_MARGIN_SECS = 3_600n;

/**
 * Seconds before its `end_time` from which a vault stream takes no draw and no redeem (the
 * engine's `SOL_DRAW_CUTOFF_SECS`, spec 7.3): a draw is accepted while `now + 300 < end_time`.
 * After the end, Streamflow's auto-claim moves the remainder into the vault and
 * `sync_sol_stream` books it in the class's swept balance.
 */
export const SOL_DRAW_CUTOFF_SECS = 300n;

/**
 * Spec 7.2 rules on the metadata alone, as the engine's `check_deposit` and attribution apply
 * them: nothing the sender could still change, no automatic withdrawal, no pause or rate-change
 * history, no Streamflow or partner fee (raw bits, so `-0.0` counts), and, given `nowSecs`, an
 * `end_time` more than an hour away (Streamflow's auto-claim empties a stream at its end). The
 * mint and the amount left to lock are checked separately.
 */
export function checkStreamflowEligibility(metadata: StreamflowMetadata, nowSecs?: bigint): StreamflowEligibility {
  const reasons: StreamflowEligibilityReason[] = [];
  if (metadata.closed) reasons.push("closed");
  if (metadata.canceledAt !== 0n) reasons.push("canceled");
  if (metadata.cancelableBySender) reasons.push("cancelable_by_sender");
  if (metadata.transferableBySender) reasons.push("transferable_by_sender");
  if (!metadata.transferableByRecipient) reasons.push("not_transferable_by_recipient");
  if (metadata.pausable) reasons.push("pausable");
  if (metadata.canUpdateRate) reasons.push("can_update_rate");
  if (metadata.canTopup) reasons.push("can_topup");
  if (metadata.automaticWithdrawal) reasons.push("automatic_withdrawal");
  if (metadata.currentPauseStart !== 0n || metadata.pauseCumulative !== 0n || metadata.lastRateChangeTime !== 0n || metadata.fundsUnlockedAtLastRateChange !== 0n) reasons.push("modified");
  const fees = [metadata.streamflowFeeTotal, metadata.streamflowFeeWithdrawn, metadata.partnerFeeTotal, metadata.partnerFeeWithdrawn].some((value) => value !== 0n);
  if (fees || metadata.streamflowFeePercentBits !== 0 || metadata.partnerFeePercentBits !== 0) reasons.push("fees");
  if (nowSecs !== undefined && metadata.endTime <= nowSecs + DEPOSIT_END_MARGIN_SECS) reasons.push("ends_too_soon");
  return { eligible: reasons.length === 0, reasons };
}

export const STREAMFLOW_ELIGIBILITY_MESSAGES: Record<StreamflowEligibilityReason, string> = {
  closed: "The stream is closed.",
  canceled: "The stream was canceled.",
  cancelable_by_sender: "The sender can still cancel the stream.",
  transferable_by_sender: "The sender can still transfer the stream.",
  not_transferable_by_recipient: "The recipient cannot transfer the stream.",
  pausable: "The stream can be paused.",
  can_update_rate: "The sender can change the unlock rate.",
  can_topup: "The sender can top the stream up, which would change the schedule.",
  automatic_withdrawal: "The stream withdraws automatically; the engine must control every withdrawal.",
  modified: "The stream was paused or re-rated; its unlocks no longer follow the plain schedule.",
  fees: "Withdrawals from the stream pay Streamflow or partner fees; the engine only holds fee-free streams.",
  ends_too_soon: "The stream ends within an hour: Streamflow's auto-claim would empty it before the deposit completes.",
};

/** Associated token account of `owner` for `mint` (classic SPL Token). */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

export interface TransferRecipientParams {
  metadataPubkey: PublicKey;
  /** Current recipient, the only signer. */
  authority: PublicKey;
  newRecipient: PublicKey;
  mint: PublicKey;
  program?: PublicKey;
}

/**
 * Streamflow `transfer_recipient` (port of `streamflow_transfer_recipient` in
 * `contracts/engine/src/foreign/solana.rs`): data = discriminator + 10 zero bytes; accounts
 * authority (w, s), new_recipient (w), new_recipient_tokens = ATA(new_recipient, mint) (w),
 * metadata (w), mint, rent sysvar, token program, associated token program, system program.
 */
export function transferRecipientInstruction(params: TransferRecipientParams): TransactionInstruction {
  const data = new Uint8Array(18);
  data.set(STREAMFLOW_TRANSFER_RECIPIENT_DISCRIMINATOR, 0);
  return new TransactionInstruction({
    programId: params.program ?? STREAMFLOW_DEVNET_PROGRAM,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: params.newRecipient, isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(params.newRecipient, params.mint), isSigner: false, isWritable: true },
      { pubkey: params.metadataPubkey, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export type TransferRecipientTransactionParams = TransferRecipientParams & {
  /** From `getLatestBlockhash`; an expired blockhash only means a retry (nothing is debited by the move). */
  blockhash: string;
  lastValidBlockHeight: number;
  /** Pays the fee and the rent of the new recipient's token account when missing (defaults to the authority). */
  feePayer?: PublicKey;
};

/**
 * The holder's transaction moving a stream to its rose deposit address (spec 7.2 step 1). The
 * program creates the new recipient's token account when missing and charges the signer, so the
 * holder (fee payer) must hold a little SOL.
 */
export function buildTransferRecipientTransaction(params: TransferRecipientTransactionParams): Transaction {
  const transaction = new Transaction({ blockhash: params.blockhash, lastValidBlockHeight: params.lastValidBlockHeight, feePayer: params.feePayer ?? params.authority });
  transaction.add(transferRecipientInstruction(params));
  return transaction;
}
