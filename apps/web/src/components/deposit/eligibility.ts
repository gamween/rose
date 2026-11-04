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
 * Solana eligibility: the SDK rules plus no automatic withdrawal (the engine sizes its own
 * withdraws inside payouts) and a classic SPL Token mint (Token-2022 is not modeled).
 */
export function solanaVerdict(metadata: StreamflowMetadata, mintOwner: PublicKey | null): Verdict {
  const result = checkStreamflowEligibility(metadata);
  const reasons = result.reasons.map((reason) => STREAMFLOW_ELIGIBILITY_MESSAGES[reason]);
  if (metadata.automaticWithdrawal) reasons.push("The stream withdraws automatically; the engine must control every withdrawal.");
  if (mintOwner === null) reasons.push("The mint account could not be read.");
  else if (!mintOwner.equals(TOKEN_PROGRAM_ID)) reasons.push("The mint is not a classic SPL Token mint (Token-2022 is not supported).");
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

/** `compute_sol_class_id` arguments of a Streamflow stream (every field is a `u64`, JSON number). */
export function streamflowScheduleArgs(metadata: StreamflowMetadata): StreamflowScheduleArgs {
  return {
    start_time: Number(metadata.startTime),
    end_time: Number(metadata.endTime),
    net_amount_deposited: Number(metadata.netAmountDeposited),
    period: Number(metadata.period),
    amount_per_period: Number(metadata.amountPerPeriod),
    cliff: Number(metadata.cliff),
    cliff_amount: Number(metadata.cliffAmount),
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
