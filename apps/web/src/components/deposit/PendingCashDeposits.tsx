"use client";

/**
 * "Cash waiting for registration": Base cash deposits this browser made (`depositCash` on
 * RoseVault) whose registration on NEAR did not finish, because the tab was closed during the
 * Base finality wait or the registration failed and the page was left. The tokens sit in
 * RoseVault, uncredited, until the `CashDeposited` log is registered, which any NEAR account can
 * do. "Register" re-reads the receipt by hash, decodes the log, waits for Base finality when it is
 * not reached yet, and sends `register_base_cash` only when the engine has no verification of the
 * log (`get_replay`); a deposit is never sent again.
 */

import type { CashDepositedLog } from "@rose/sdk";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatDate, formatVenueCash, venueLabel } from "@/lib/amounts";
import { deployedAddress } from "@/lib/deployment";
import { requireEngine } from "@/lib/engine-client";
import { RoseActionError, toActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { useVenueDecimals } from "@/lib/token-symbols";
import { useFlow, type StepDefinition } from "@/lib/use-action";
import { useEngineQuery } from "@/lib/use-engine-query";
import { awaitsRegistration, cashAttempts, forgetAttempted, keyId, loadAttempted, matchCashLog, type AttemptedDeposit, type BaseCashAttempt } from "./attempted";

type CashAttempt = AttemptedDeposit & { baseTx: string; cash: BaseCashAttempt };

/**
 * Blocks past the safe head after which the 30 s margin for the MPC providers (spec 7.1) is moot:
 * 150 Base blocks are 5 minutes, so a deposit resumed after a reload registers at once.
 */
const SETTLED_BLOCKS = 150n;

function PendingRow({ attempt, busy, canRegister, reason, onRegister, onDismiss }: { attempt: CashAttempt; busy: boolean; canRegister: boolean; reason: string | null; onRegister: () => void; onDismiss: () => void }) {
  const venue = { Base: { token: attempt.cash.token } };
  const decimals = useVenueDecimals(venue);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-pending-cash-row={keyId(attempt.key)}>
      <div className="min-w-0 text-[13px]">
        <p className="tabular text-ink-50">
          {formatVenueCash(BigInt(attempt.cash.amount), decimals)} {venueLabel(venue).replace(/^Base /, "")}
        </p>
        <p className="text-[12px] text-ink-400 [overflow-wrap:anywhere]">
          Deposited {formatDate(attempt.attemptedAt)} for {attempt.cash.creditTo} (round label {attempt.cash.roundId}).{" "}
          <a href={txLinks("base", attempt.baseTx)[0]!.href} target="_blank" rel="noreferrer" className="text-ember-300 underline-offset-2 hover:underline">
            depositCash ↗
          </a>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy} data-dismiss-pending-cash>
          Dismiss
        </Button>
        <Button size="sm" onClick={onRegister} disabled={busy || !canRegister} title={reason ?? undefined} data-register-pending-cash>
          Register
        </Button>
      </div>
    </li>
  );
}

/**
 * Lists the unregistered Base cash deposits of this browser, optionally only those of `token`
 * credited to `creditTo`; `exclude` hides the deposit a flow on the same page is registering.
 */
export function PendingCashDeposits({ token, creditTo, exclude, refreshKey, onRegistered }: { token?: string; creditTo?: string; exclude?: string | null; refreshKey?: number; onRegistered?: () => void }) {
  const wallets = useWallets();
  const [attempts, setAttempts] = useState<CashAttempt[]>([]);
  const [active, setActive] = useState<CashAttempt | null>(null);
  const flow = useFlow({ onComplete: onRegistered });

  useEffect(() => {
    const timer = window.setTimeout(() => setAttempts(cashAttempts(loadAttempted(), { token, creditTo })), 0);
    return () => window.clearTimeout(timer);
  }, [token, creditTo, refreshKey, flow.completed]);

  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<CashAttempt[]> => {
      if (attempts.length === 0) return [];
      const { views } = requireEngine();
      const states = await Promise.all(attempts.map((attempt) => Promise.all([views.raw.getReplay(attempt.key, { signal }), views.raw.getRefusedDeposit(attempt.key, { signal })])));
      return attempts.filter((_, index) => awaitsRegistration(states[index]![0], states[index]![1]));
    },
    [attempts],
  );
  const query = useEngineQuery(fetcher, { enabled: attempts.length > 0, pollMs: 60_000 });

  const register = (attempt: CashAttempt) => {
    const vault = deployedAddress("roseVault");
    if (!vault) return;
    setActive(attempt);
    const hash = attempt.baseTx as `0x${string}`;
    const context: { log?: CashDepositedLog } = {};
    const steps: StepDefinition[] = [
      {
        id: "receipt",
        label: "Read the depositCash receipt on Base",
        run: async (step) => {
          step.addLinks(txLinks("base", hash));
          const { basePublicClient, decodeCashDeposited } = await import("@/components/rounds/base-cash");
          const receipt = await basePublicClient().getTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new RoseActionError("contract", "depositCash reverted", "This deposit reverted on Base Sepolia: nothing left the wallet and there is nothing to register. Dismiss it.");
          const log = matchCashLog(decodeCashDeposited(receipt), attempt.key, vault);
          if (!log) throw new RoseActionError("contract", "No CashDeposited log", "The receipt holds no RoseVault CashDeposited log at the recorded index.");
          context.log = log;
          return { message: `CashDeposited in block ${log.blockNumber.toString()} for ${log.args.nearAccount}.` };
        },
      },
      {
        id: "finality",
        label: "Base finality (safe head plus a 30 s margin)",
        run: async (step) => {
          const { basePublicClient, waitForSafeHead } = await import("@/components/rounds/base-cash");
          const client = basePublicClient();
          const safe = await client.getBlock({ blockTag: "safe" });
          if (safe.number >= context.log!.blockNumber + SETTLED_BLOCKS) return { message: `Final since long ago (safe head ${safe.number.toString()}).` };
          await waitForSafeHead(client, context.log!.blockNumber, {
            signal: step.signal,
            onProgress: (progress) => step.setDetail(progress.phase === "ready" ? "Safe." : progress.phase === "margin" ? "Safe head passed; 30 s margin for the MPC providers…" : `Safe head ${progress.safeHead.toString()} / target ${progress.target.toString()}…`),
          });
          return { message: "Base finality reached." };
        },
      },
      {
        id: "register",
        label: "register_base_cash on the engine (MPC verification, about 10 s)",
        run: async (step) => {
          const { registerBaseCashArgs, registerCashDeposit, replayKeyOf } = await import("@/components/rounds/base-cash");
          const engine = requireEngine();
          const args = registerBaseCashArgs(context.log!);
          const result = await registerCashDeposit(
            engine.views,
            replayKeyOf(args.location),
            async () => {
              step.setDetail("Confirm register_base_cash in your NEAR wallet…");
              try {
                const outcome = await wallets.sendNearCall(engine.calls.registerBaseCash(args.location, { ...args.fields }));
                step.addLinks(txLinks("near", outcome.transaction.hash));
                step.setDetail("MPC verification in progress…");
                return { ok: true, outcome, hash: outcome.transaction.hash };
              } catch (error) {
                return { ok: false, error: toActionError(error) };
              }
            },
            { signal: step.signal, onWaiting: (elapsed) => step.setDetail(`MPC verification in progress (${String(Math.round(elapsed / 1000))} s)…`) },
          );
          return { message: result.hash ? `Credited to the Base cash of ${attempt.cash.creditTo}.` : `Already registered: credited to the Base cash of ${attempt.cash.creditTo}.` };
        },
      },
    ];
    void flow.start(steps);
  };

  const rows = query.state.status === "ok" ? query.state.value.filter((attempt) => keyId(attempt.key) !== exclude) : [];
  const showFlow = active !== null && flow.steps.length > 0;
  if (rows.length === 0 && !showFlow) return null;
  const nearReason = wallets.near.accountId ? null : "Connect a NEAR wallet: it signs register_base_cash.";

  return (
    <section className="flex flex-col gap-3 rounded-md border border-warning-400/40 bg-ink-900 p-3" data-pending-cash>
      <div>
        <h4 className="font-display text-[11px] uppercase tracking-wide text-ink-200">Cash waiting for registration</h4>
        <p className="mt-1 text-[12px] text-ink-400">Deposits this browser made into RoseVault whose registration on NEAR did not finish. The tokens are safe in RoseVault; registering credits them and never deposits again.</p>
      </div>
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((attempt) => (
            <PendingRow
              key={keyId(attempt.key)}
              attempt={attempt}
              busy={flow.running}
              canRegister={nearReason === null}
              reason={nearReason}
              onRegister={() => register(attempt)}
              onDismiss={() => setAttempts(cashAttempts(forgetAttempted(attempt.key), { token, creditTo }))}
            />
          ))}
        </ul>
      ) : null}
      {showFlow ? (
        <div className="flex flex-col gap-2" data-pending-cash-flow>
          <p className="text-[12px] text-ink-300 [overflow-wrap:anywhere]">Registering the deposit of {formatDate(active.attemptedAt)} for {active.cash.creditTo}</p>
          <FlowSteps steps={flow.steps} running={flow.running} onRetry={() => void flow.retry()} />
        </div>
      ) : null}
    </section>
  );
}
