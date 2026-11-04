/**
 * Base reads of the deposit wizard: the holder's Sablier v4 streams in a bounded id range with
 * eligibility and the class each would join, and the poll of the engine's replay key once
 * `register_base_deposit` is sent (spec 7.1 step 3).
 */

import { listOwnedStreams, readStream, type EngineViews, type ReplayKey, type ReplayStateView, type SablierStream } from "@rose/sdk";
import type { Address, PublicClient } from "viem";
import { RoseActionError } from "@/lib/errors";
import { baseVerdict, sablierScheduleArgs, scanRange, type Verdict } from "./eligibility";
import { sleep } from "@/lib/payouts";
import { SETTLED_POLLS } from "./solana-reads";

/** Ids scanned per page of the Sablier list (the Lockup NFT is not enumerable). */
export const BASE_SCAN_SPAN = 200n;

export type BaseStreamRow = {
  streamId: bigint;
  stream: SablierStream | null;
  verdict: Verdict;
  classId: string | null;
  classExists: boolean | null;
};

export type BaseListing = { rows: BaseStreamRow[]; fromId: bigint; toId: bigint; nextStreamId: bigint };

/** The streams `owner` holds between `fromId` and `toId` (newest first), read one by one with their verdicts. */
export async function listBaseStreams(client: PublicClient, views: EngineViews, owner: Address, lockup: Address, range: { fromId: bigint; toId: bigint }, signal?: AbortSignal): Promise<BaseStreamRow[]> {
  const ids = await listOwnedStreams(client, owner, { lockup, fromId: range.fromId, toId: range.toId });
  const rows: BaseStreamRow[] = [];
  for (const streamId of ids) {
    let stream: SablierStream | null = null;
    let decimalsError: string | null = null;
    try {
      stream = await readStream(client, streamId, lockup);
    } catch (error) {
      decimalsError = error instanceof Error && /decimals/i.test(error.message) ? "The token has no decimals()." : `The stream could not be read: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`;
    }
    const verdict = baseVerdict(stream, decimalsError);
    let classId: string | null = null;
    let classExists: boolean | null = null;
    if (verdict.eligible && stream) {
      try {
        classId = await views.raw.computeBaseClassId(stream.token.toLowerCase(), stream.decimals, sablierScheduleArgs(stream), { signal });
        classExists = (await views.raw.getClass(classId, { signal })) !== null;
      } catch (error) {
        verdict.eligible = false;
        verdict.reasons.push(error instanceof Error ? `The engine refuses this schedule: ${error.message.slice(0, 160)}` : "The engine refuses this schedule.");
      }
    }
    rows.push({ streamId, stream, verdict, classId, classExists });
  }
  return rows;
}

/** The newest ids to scan first: `[nextStreamId - span, nextStreamId - 1]`. */
export function initialRange(nextStreamId: bigint): { fromId: bigint; toId: bigint } {
  return scanRange(nextStreamId - 1n, BASE_SCAN_SPAN);
}

const REPLAY_WAIT_MS = 150_000;
const REPLAY_POLL_MS = 3_000;

export type ReplayOutcome = "consumed" | "cleared";

/** Units of `classId` held by `account`; zero while the class does not exist (a deposit's first stream creates it). */
export async function holdingBalance(views: EngineViews, account: string, classId: string): Promise<bigint> {
  if ((await views.getClass(classId)) === null) return 0n;
  return (await views.getHolding(account, classId)).balance;
}

/**
 * Polls `get_replay(key)` after a registration call: `Consumed` means the MPC matched the log
 * (minted or refused, see `get_refused_deposit`); a key that was `Pending` and disappears means
 * the callback failed (`PromiseError` or mismatch) and the call may be sent again. With
 * `sentNow` (this tab's call just returned, its callback included) an absent key means the
 * same at once, instead of after the 2.5-minute wait.
 */
export async function waitForReplay(views: EngineViews, key: ReplayKey, options: { signal?: AbortSignal; onPoll?: (elapsedMs: number, state: ReplayStateView | null) => void; sentNow?: boolean } = {}): Promise<ReplayOutcome> {
  const started = Date.now();
  let seenPending = false;
  for (let poll = 1; ; poll += 1) {
    const state = await views.raw.getReplay(key, { signal: options.signal });
    if (state === "Consumed") return "consumed";
    if (state === null && (seenPending || (options.sentNow && poll >= SETTLED_POLLS))) return "cleared";
    if (state !== null) seenPending = true;
    const elapsed = Date.now() - started;
    options.onPoll?.(elapsed, state);
    if (elapsed > REPLAY_WAIT_MS) {
      throw new RoseActionError("mpc_timeout", "MPC verification timed out", "The MPC nodes did not answer in about 2 minutes: the Base transaction may not be safe yet for their providers, or a value differs. Retry sends the registration again.", true);
    }
    await sleep(REPLAY_POLL_MS, options.signal);
  }
}
