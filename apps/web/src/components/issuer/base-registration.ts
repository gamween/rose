/**
 * Registering RoseVault logs on the engine (spec 7.1 step 3 for `StreamDeposited`, the same
 * flow for `CashDeposited`): the call, then polling the replay key until the MPC verification
 * consumed it (measured 6 to 9 s) or the deposit was refused; a verification that never answers
 * surfaces as a retryable timeout after about 2 min, like the engine's own `PromiseError`.
 */

import {
  registerBaseCashArgs,
  registerBaseDepositArgs,
  type BaseLogLocation,
  type CashDepositedLog,
  type FinalExecutionOutcome,
  type FunctionCall,
  type RefusedDepositView,
  type ReplayKey,
  type StreamDepositedLog,
} from "@rose/sdk";
import type { EngineClient } from "@/lib/engine-client";
import { RoseActionError } from "@/lib/errors";
import { sablierScheduleArgs } from "./class-schedule";

export const REGISTRATION_WAIT_MS = 150_000;
const POLL_MS = 3_000;

/** The engine's replay key of a RoseVault log (transaction hash without `0x`, block-level log index). */
export function replayKeyOf(location: BaseLogLocation): ReplayKey {
  return { BaseLog: { tx_hash: location.tx_hash.replace(/^0x/, "").toLowerCase(), log_index: location.log_index } };
}

export type ReplayOutcome = { outcome: "consumed" } | { outcome: "refused"; refused: RefusedDepositView };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Polls `get_replay` / `get_refused_deposit` for `key` until the verification settled. */
export async function waitForReplay(engine: EngineClient, key: ReplayKey, options: { signal?: AbortSignal; onPoll?: (elapsedMs: number) => void } = {}): Promise<ReplayOutcome> {
  const started = Date.now();
  for (;;) {
    const [state, refused] = await Promise.all([engine.views.raw.getReplay(key, { signal: options.signal }), engine.views.raw.getRefusedDeposit(key, { signal: options.signal })]);
    if (refused) return { outcome: "refused", refused };
    if (state === "Consumed") return { outcome: "consumed" };
    const elapsed = Date.now() - started;
    options.onPoll?.(elapsed);
    if (elapsed > REGISTRATION_WAIT_MS) {
      throw new RoseActionError(
        "mpc_timeout",
        "MPC verification timed out",
        "The MPC nodes did not confirm the log within 2.5 minutes. Causes: the Base transaction is not final for their providers yet, or a lagging node. The engine clears the pending key after about 2 minutes; retry.",
        true,
      );
    }
    if (state === null) {
      throw new RoseActionError("contract", "Registration not recorded", "The engine has no pending verification for this log. Retry the registration.", true);
    }
    await sleep(POLL_MS, options.signal);
  }
}

export type SendNearCall = (call: FunctionCall) => Promise<FinalExecutionOutcome>;

export type StreamRegistration = { log: StreamDepositedLog; classId: string; key: ReplayKey };

/** The class id of a `StreamDeposited` log, exactly as the engine will compute it. */
export async function classIdOfLog(engine: EngineClient, log: StreamDepositedLog, signal?: AbortSignal): Promise<string> {
  const a = log.args;
  return engine.views.raw.computeBaseClassId(
    a.token.toLowerCase(),
    a.decimals,
    sablierScheduleArgs({ start: BigInt(a.start), cliff: BigInt(a.cliff), end: BigInt(a.end), granularity: BigInt(a.granularity), deposited: a.deposited, startUnlock: a.startUnlock, cliffUnlock: a.cliffUnlock }),
    { signal },
  );
}

/**
 * Registers one `StreamDeposited` log for its holder: skips logs already consumed, attaches the
 * holder's registration deposit, then waits for the verification. Safe to call again after a
 * failure (the engine refuses a second request while one is pending and consumes a key once).
 */
export async function registerStreamLog(
  engine: EngineClient,
  send: SendNearCall,
  log: StreamDepositedLog,
  options: { signal?: AbortSignal; onDetail?: (text: string) => void } = {},
): Promise<{ outcome: ReplayOutcome; txHash: string | null; classId: string }> {
  const args = registerBaseDepositArgs(log);
  const key = replayKeyOf(args.location);
  const classId = await classIdOfLog(engine, log, options.signal);
  const existing = await engine.views.raw.getReplay(key, { signal: options.signal });
  if (existing === "Consumed") return { outcome: { outcome: "consumed" }, txHash: null, classId };
  let txHash: string | null = null;
  if (existing === null) {
    const deposit = await engine.views.registrationDepositFor(log.args.nearAccount, classId, { signal: options.signal });
    options.onDetail?.(`Sending register_base_deposit for ${log.args.nearAccount} (storage ${deposit.toString()} yocto)…`);
    const outcome = await send(engine.calls.registerBaseDeposit(args.location, args.fields, deposit));
    txHash = outcome.transaction.hash;
  }
  options.onDetail?.("MPC verification in progress (about 7 s)…");
  const outcome = await waitForReplay(engine, key, { signal: options.signal, onPoll: (elapsed) => options.onDetail?.(`MPC verification in progress (${String(Math.round(elapsed / 1000))} s)…`) });
  return { outcome, txHash, classId };
}

/** Registers one `CashDeposited` log (credits the NEAR account's Base cash). */
export async function registerCashLog(engine: EngineClient, send: SendNearCall, log: CashDepositedLog, options: { signal?: AbortSignal; onDetail?: (text: string) => void } = {}): Promise<{ outcome: ReplayOutcome; txHash: string | null }> {
  const args = registerBaseCashArgs(log);
  const key = replayKeyOf(args.location);
  const existing = await engine.views.raw.getReplay(key, { signal: options.signal });
  if (existing === "Consumed") return { outcome: { outcome: "consumed" }, txHash: null };
  let txHash: string | null = null;
  if (existing === null) {
    options.onDetail?.("Sending register_base_cash…");
    const outcome = await send(engine.calls.registerBaseCash(args.location, args.fields));
    txHash = outcome.transaction.hash;
  }
  options.onDetail?.("MPC verification in progress (about 7 s)…");
  const outcome = await waitForReplay(engine, key, { signal: options.signal, onPoll: (elapsed) => options.onDetail?.(`MPC verification in progress (${String(Math.round(elapsed / 1000))} s)…`) });
  return { outcome, txHash };
}
