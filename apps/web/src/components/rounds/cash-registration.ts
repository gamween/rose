/**
 * Registration of a `CashDeposited` log from the order form (spec 7.1, the cash venue). The
 * transaction succeeds even when the MPC does not attest the log: `on_base_cash_verified`
 * returns `false` on a mismatch or a `PromiseError` (custody/base.rs) and nothing is credited. So
 * the callback's value and the replay key are read before anything is called "credited", and a
 * failed verification asks for a retry of the registration only: the cash already sits in
 * RoseVault and the same log can be registered again (spec 7.1 "verification timed out, retry").
 */

import { outcomeValue, type EngineViews, type FinalExecutionOutcome, type ReplayKey } from "@rose/sdk";
import { RoseActionError, type ActionError } from "@/lib/errors";

export const CASH_REGISTRATION_WAIT_MS = 150_000;
const POLL_MS = 3_000;

export type SendRegistration = () => Promise<{ ok: true; outcome: FinalExecutionOutcome; hash: string } | { ok: false; error: ActionError }>;

export interface CashRegistrationOptions {
  signal?: AbortSignal;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWaiting?: (elapsedMs: number) => void;
}

function verificationFailed(): RoseActionError {
  return new RoseActionError(
    "mpc_timeout",
    "MPC verification failed",
    "The MPC did not attest the CashDeposited log (it timed out or a value differed), so nothing was credited. Your cash is safe in RoseVault: retry the registration (the deposit is not sent again).",
    true,
  );
}

async function refusal(views: Pick<EngineViews, "raw">, key: ReplayKey): Promise<RoseActionError | null> {
  const refused = await views.raw.getRefusedDeposit(key);
  return refused ? new RoseActionError("contract", "Deposit refused by the engine", `${refused.reason}. The cash stays in RoseVault; withdraw it from the Portfolio.`) : null;
}

/**
 * Registers the log whose replay key is `key` (sending `register_base_cash` only when the engine
 * has no pending verification for it), then waits until the engine consumed the key. Resolves
 * once the cash is credited; throws a retryable `mpc_timeout` when the verification failed.
 */
export async function registerCashDeposit(views: Pick<EngineViews, "raw">, key: ReplayKey, send: SendRegistration, options: CashRegistrationOptions = {}): Promise<{ hash: string | null }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  let state = await views.raw.getReplay(key, { signal: options.signal });
  let hash: string | null = null;
  if (state === null) {
    const sent = await send();
    if (!sent.ok) throw new RoseActionError(sent.error.kind, sent.error.title, sent.error.message, sent.error.retryable);
    hash = sent.hash;
    if (outcomeValue(sent.outcome) === false) throw (await refusal(views, key)) ?? verificationFailed();
    state = await views.raw.getReplay(key, { signal: options.signal });
  }
  const started = now();
  let seenPending = false;
  while (state !== "Consumed") {
    if (state === null) {
      if (seenPending) throw verificationFailed();
      throw new RoseActionError("contract", "Registration not recorded", "The engine has no verification for this log. Retry the registration.", true);
    }
    seenPending = true;
    const elapsed = now() - started;
    options.onWaiting?.(elapsed);
    if (elapsed > CASH_REGISTRATION_WAIT_MS) throw verificationFailed();
    await sleep(POLL_MS);
    state = await views.raw.getReplay(key, { signal: options.signal });
  }
  const refused = await refusal(views, key);
  if (refused) throw refused;
  return { hash };
}
