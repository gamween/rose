/**
 * Pure helpers of the deposit wizard: the app-side eligibility rules on top of the SDK's chain
 * rules (spec 7.1 and 7.2), the schedule arguments of the engine's class-id views, replay keys
 * and the SPL mint layout. Everything here is testable without a network.
 */

import {
  checkEligibility,
  checkStreamflowEligibility,
  ELIGIBILITY_MESSAGES,
  STREAMFLOW_ELIGIBILITY_MESSAGES,
  TOKEN_PROGRAM_ID,
  type ReplayKey,
  type SablierScheduleArgs,
  type SablierStream,
  type StreamDepositedLog,
  type StreamflowMetadata,
  type StreamflowScheduleArgs,
} from "@rose/sdk";
import type { PublicKey } from "@solana/web3.js";

/** Size of a classic SPL Token mint account; `decimals` sits at byte 44 (verified live, docs/verification.md). */
export const SPL_MINT_ACCOUNT_LEN = 82;
const SPL_MINT_DECIMALS_OFFSET = 44;

export type Verdict = { eligible: boolean; reasons: string[] };

/** Base eligibility: the SDK rules plus "the token exposes decimals()" (the vault reads them on chain). */
export function baseVerdict(stream: SablierStream | null, decimalsError: string | null): Verdict {
  if (!stream) return { eligible: false, reasons: [decimalsError ?? "The stream could not be read."] };
  const result = checkEligibility(stream);
  const reasons = result.reasons.map((reason) => ELIGIBILITY_MESSAGES[reason]);
  if (decimalsError) reasons.push(decimalsError);
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Whether a Streamflow stream charges Streamflow or partner fees on withdrawals (`streamflow_fee_total`
 * 305, `_withdrawn` 313, `_percent` f32 321, `partner_fee_total` 389, `_withdrawn` 397, `_percent`
 * f32 405, little-endian, as `foreign::solana` in the engine reads them).
 */
export function streamflowChargesFees(raw: Uint8Array): boolean {
  if (raw.length < 409) return true;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return [305, 313, 389, 397].some((offset) => view.getBigUint64(offset, true) !== 0n) || [321, 405].some((offset) => view.getFloat32(offset, true) !== 0);
}

/** `freeze_authority` of a classic SPL mint: a `COption<Pubkey>` whose `u32` tag sits at byte 46 (spec 7.2, verified on devnet). */
const SPL_MINT_FREEZE_TAG_OFFSET = 46;

/** Whether an 82-byte SPL mint has a freeze authority (its holder could freeze the vault's token account). */
export function mintHasFreezeAuthority(data: Uint8Array): boolean {
  if (data.length !== SPL_MINT_ACCOUNT_LEN) return true;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(SPL_MINT_FREEZE_TAG_OFFSET, true) !== 0;
}

/** Pause or rate-change history (`current_pause_start` 672, `pause_cumulative` 680, `last_rate_change_time` 688, `funds_unlocked_at_last_rate_change` 696). */
function streamflowModified(metadata: StreamflowMetadata): boolean {
  return metadata.currentPauseStart !== 0n || metadata.pauseCumulative !== 0n || metadata.lastRateChangeTime !== 0n || metadata.fundsUnlockedAtLastRateChange !== 0n;
}

/**
 * Solana eligibility: the SDK rules plus the checks the engine applies at attribution (spec 7.2):
 * no automatic withdrawal (the engine sizes its own withdraws inside payouts), no withdrawal fees
 * (the engine's withdraws carry no fee accounts), no pause or rate-change history, a classic SPL
 * Token mint (Token-2022 is not modeled) without a freeze authority, at least one whole token
 * left to lock, and a schedule not fully unlocked at `nowSec`. A stream refused there would cost a
 * transfer, an attribution and a return.
 */
export function solanaVerdict(metadata: StreamflowMetadata, mint: { owner: PublicKey; data: Uint8Array; decimals: number } | null, raw: Uint8Array, nowSec: bigint): Verdict {
  const result = checkStreamflowEligibility(metadata);
  const reasons = result.reasons.map((reason) => STREAMFLOW_ELIGIBILITY_MESSAGES[reason]);
  if (metadata.automaticWithdrawal) reasons.push("The stream withdraws automatically; the engine must control every withdrawal.");
  if (streamflowChargesFees(raw)) reasons.push("Withdrawals from the stream pay Streamflow or partner fees; the engine only holds fee-free streams.");
  if (streamflowModified(metadata)) reasons.push("The stream was paused or re-rated; its unlocks no longer follow the plain schedule.");
  if (mint === null) reasons.push("The mint account could not be read.");
  else if (!mint.owner.equals(TOKEN_PROGRAM_ID)) reasons.push("The mint is not a classic SPL Token mint (Token-2022 is not supported).");
  else {
    if (mintHasFreezeAuthority(mint.data)) reasons.push("The mint has a freeze authority: its holder could freeze the vault's token account and block every payout.");
    const oneToken = 10n ** BigInt(mint.decimals);
    if (metadata.amountWithdrawn >= metadata.netAmountDeposited) reasons.push("The stream is fully withdrawn.");
    else if (metadata.netAmountDeposited < oneToken || metadata.netAmountDeposited - metadata.amountWithdrawn < oneToken) reasons.push("The stream holds less than one whole token.");
  }
  if (metadata.endTime > 0n && nowSec >= metadata.endTime) reasons.push("The stream is fully unlocked: withdraw it instead.");
  return { eligible: reasons.length === 0, reasons };
}

/** `compute_base_class_id` arguments of a stream (`cliff` is 0 when the stream has none). */
export function sablierScheduleArgs(stream: SablierStream): SablierScheduleArgs {
  return {
    start: stream.start,
    cliff: stream.cliff,
    end: stream.end,
    granularity: stream.granularity,
    deposited: stream.deposited.toString(),
    start_unlock: stream.unlockAmounts.start.toString(),
    cliff_unlock: stream.unlockAmounts.cliff.toString(),
  };
}

/** `compute_sol_class_id` arguments of a Streamflow stream: times as JSON numbers, token amounts as `U64` strings. */
export function streamflowScheduleArgs(metadata: StreamflowMetadata): StreamflowScheduleArgs {
  return {
    start_time: Number(metadata.startTime),
    end_time: Number(metadata.endTime),
    net_amount_deposited: metadata.netAmountDeposited.toString(),
    period: Number(metadata.period),
    amount_per_period: metadata.amountPerPeriod.toString(),
    cliff: Number(metadata.cliff),
    cliff_amount: metadata.cliffAmount.toString(),
  };
}

/** The engine's replay key of a RoseVault log: lowercase transaction hash without `0x` and the block-level log index. */
export function baseLogReplayKey(log: Pick<StreamDepositedLog, "transactionHash" | "logIndex">): ReplayKey {
  return { BaseLog: { tx_hash: log.transactionHash.toLowerCase().replace(/^0x/, ""), log_index: log.logIndex } };
}

export function solStreamReplayKey(metadata: string): ReplayKey {
  return { SolStream: { metadata } };
}

/** Decimals of a classic SPL mint from its 82 raw bytes. */
export function mintDecimals(data: Uint8Array): number {
  if (data.length !== SPL_MINT_ACCOUNT_LEN) throw new Error(`Expected ${String(SPL_MINT_ACCOUNT_LEN)} mint bytes, got ${String(data.length)}.`);
  const decimals = data[SPL_MINT_DECIMALS_OFFSET];
  if (decimals === undefined) throw new Error("The mint account has no decimals byte.");
  return decimals;
}

/** Tokens still to be streamed after the vested part is withdrawn at deposit time. */
export function remainingToLock(stream: SablierStream): bigint {
  const remaining = stream.deposited - stream.withdrawn - stream.withdrawable;
  return remaining > 0n ? remaining : 0n;
}

/** Id range `[from, to]` scanned by the Base list: the newest `span` ids below `toId`, never below 1. */
export function scanRange(toId: bigint, span: bigint): { fromId: bigint; toId: bigint } {
  const fromId = toId - span + 1n > 1n ? toId - span + 1n : 1n;
  return { fromId, toId };
}
