"use client";

/**
 * Funds the viewer's cash in the round's venue before an order (spec 5.4 cash venue). NEAR
 * venue: the storage deposit the account misses for its cash row (spec 4), then
 * `ft_transfer_call` of tUSDC into the engine, from one button. Base venue: `approve` and
 * `RoseVault.depositCash` with the connected EVM wallet, wait for Base's safe head, then
 * `register_base_cash` so the engine verifies the log through the MPC and credits the ledger
 * (it pays the cash row out of its record deposit). The cash is reported credited only once the
 * engine consumed the log; a failed verification keeps the log and offers "Retry registration",
 * which never deposits a second time. The deposit is recorded in this browser once its receipt is
 * read, so a reload during the finality wait finds it under "Cash waiting for registration".
 */

import type { CashDepositedLog, Venue } from "@rose/sdk";
import { useCallback, useState } from "react";
import { GetTestFundsButton } from "@/components/chrome/AppActions";
import { keyId, recordAttempted } from "@/components/deposit/attempted";
import { baseLogReplayKey } from "@/components/deposit/eligibility";
import { PendingCashDeposits } from "@/components/deposit/PendingCashDeposits";
import { Button } from "@/components/ui/Button";
import { Field, NumberInput } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useWallets } from "@/components/wallet/WalletProvider";
import { amountToText, formatVenueCash, venueLabel } from "@/lib/amounts";
import { cn } from "@/lib/cn";
import { deployedAddress } from "@/lib/deployment";
import { RoseActionError, toActionError, type ActionError } from "@/lib/errors";
import { txLinks, txUrl } from "@/lib/explorer";
import { depositNearCash, storageNotice, useNearCashStorageNeed } from "@/lib/near-cash";
import { useVenueDecimals } from "@/lib/token-symbols";
import { useAction } from "@/lib/use-action";
import { useNearAction } from "./actions";
import type { RoundsEngine } from "./engine";
import { addReceipt } from "./localOrders";
import { formatUsdc, parseDecimal, USDC_DECIMALS } from "./model";
import { Notice } from "./shared";

type BaseStep = "idle" | "approve" | "deposit" | "finality" | "register" | "done";

type PendingCash = { log: CashDepositedLog; amount: bigint };

const BASE_STEPS: { id: BaseStep; label: string }[] = [
  { id: "approve", label: "Approve the vault" },
  { id: "deposit", label: "depositCash on RoseVault" },
  { id: "finality", label: "Wait for Base safe head" },
  { id: "register", label: "register_base_cash (MPC proof)" },
];

export function CashDeposit({ engine, venue, roundId, shortfall, nearCashToken, onDeposited }: { engine: RoundsEngine; venue: Venue; roundId: bigint; shortfall: bigint; nearCashToken: string; onDeposited: () => void }) {
  const { near, evm, balances, getEvmWalletClient, refreshBalances, sendNearCall, restoring } = useWallets();
  const toast = useToast();
  const { run } = useNearAction();
  const nearDeposit = useAction();
  const storageNeed = useNearCashStorageNeed(venue === "Near" ? engine : null, near.accountId, nearDeposit.state.status);
  const [editedAmount, setAmount] = useState<string | null>(null);
  /** 6 for NEAR tUSDC, the Base token's own `decimals()` (null until read). */
  const decimals = useVenueDecimals(venue);
  const scale = decimals ?? USDC_DECIMALS;
  const format = useCallback((value: bigint) => formatVenueCash(value, decimals), [decimals]);
  const unit = venueLabel(venue).replace(/^(NEAR|Base) /, "");
  /** The shortfall until the viewer types another amount (a plain decimal: the field parses no separators). */
  const amount = editedAmount ?? amountToText(shortfall, scale);
  const [baseStep, setBaseStep] = useState<BaseStep>("idle");
  const [baseError, setBaseError] = useState<ActionError | null>(null);
  const [failedStep, setFailedStep] = useState<BaseStep | null>(null);
  /** A deposit already on RoseVault whose registration has not succeeded yet. */
  const [pending, setPending] = useState<PendingCash | null>(null);
  const [finality, setFinality] = useState<string | null>(null);
  const parsed = decimals === null ? null : parseDecimal(amount, decimals);
  const valid = parsed !== null && parsed > 0n;
  const [recorded, setRecorded] = useState(0);

  const depositNear = async () => {
    if (!valid || parsed === null || !near.accountId) return;
    const account = near.accountId;
    const ok = await nearDeposit.run(`Depositing ${formatUsdc(parsed)} tUSDC into the engine`, async () => {
      const result = await depositNearCash({ send: sendNearCall, engine, token: nearCashToken, account, amount: parsed });
      if (result.storage) addReceipt(engine.account, roundId, { kind: "cash", chain: "near", hash: result.storage.hash, at: Date.now(), label: "storage_deposit (NEP-145)" });
      addReceipt(engine.account, roundId, { kind: "cash", chain: "near", hash: result.depositHash, at: Date.now(), label: "ft_transfer_call (tUSDC)" });
      return { message: `${formatUsdc(parsed)} tUSDC credited to your cash`, links: result.links };
    });
    if (ok) {
      void refreshBalances();
      onDeposited();
    }
  };

  /** Finality then registration of a deposited log; a failure keeps the log so "Retry registration" never deposits again. */
  const registerLog = useCallback(
    async (deposit: PendingCash) => {
      setBaseError(null);
      setFailedStep(null);
      let step: BaseStep = "finality";
      setBaseStep(step);
      try {
        const { basePublicClient, registerBaseCashArgs, registerCashDeposit, replayKeyOf, waitForSafeHead } = await import("./base-cash");
        await waitForSafeHead(basePublicClient(), deposit.log.blockNumber, {
          onProgress: (p) => setFinality(p.phase === "waiting_safe" ? `safe head ${p.safeHead.toString()} / ${p.target.toString()}` : p.phase === "margin" ? "safe head passed, 30 s margin for the MPC providers" : "ready"),
        });
        step = "register";
        setBaseStep(step);
        const args = registerBaseCashArgs(deposit.log);
        await registerCashDeposit(engine.views, replayKeyOf(args.location), () =>
          run({
            label: "Registering the Base cash deposit (MPC verification, about 10 s)",
            call: engine.calls.registerBaseCash(args.location, { ...args.fields }),
            success: "register_base_cash executed: reading the MPC verdict",
            receipt: { engine: engine.account, roundId, kind: "cash", label: "register_base_cash" },
          }),
        );
        toast.show({ tone: "success", title: `${format(deposit.amount)} ${unit} credited to your Base cash`, description: "The engine verified the CashDeposited log through the MPC.", links: txLinks("base", deposit.log.transactionHash) });
        setPending(null);
        setBaseStep("done");
        void refreshBalances();
        onDeposited();
      } catch (error) {
        const described = toActionError(error);
        setBaseError(described);
        setFailedStep(step);
        setBaseStep("idle");
        toast.show({ tone: "error", title: described.title, description: described.message, links: txLinks("base", deposit.log.transactionHash) });
      }
    },
    [engine, format, onDeposited, refreshBalances, roundId, run, toast, unit],
  );

  const depositBase = useCallback(async () => {
    if (!valid || parsed === null || venue === "Near") return;
    const vault = deployedAddress("roseVault");
    if (!vault) {
      setBaseError({ kind: "not_deployed", title: "RoseVault not deployed", message: "The Base venue needs RoseVault; it is not deployed yet.", retryable: false });
      return;
    }
    if (!near.accountId) return;
    setBaseError(null);
    setFailedStep(null);
    const token = venue.Base.token as `0x${string}`;
    let step: BaseStep = "approve";
    setBaseStep(step);
    let deposit: PendingCash;
    try {
      const { approveToken, basePublicClient, decodeCashDeposited, depositCash } = await import("./base-cash");
      const client = basePublicClient();
      const wallet = await getEvmWalletClient();
      const approveHash = await approveToken(wallet, token, vault, parsed);
      addReceipt(engine.account, roundId, { kind: "cash", chain: "base", hash: approveHash, at: Date.now(), label: "approve" });
      await client.waitForTransactionReceipt({ hash: approveHash });
      step = "deposit";
      setBaseStep(step);
      const hash = await depositCash(wallet, { vault, token, amount: parsed, nearAccount: near.accountId, roundId });
      addReceipt(engine.account, roundId, { kind: "cash", chain: "base", hash, at: Date.now(), label: "depositCash" });
      toast.show({ tone: "info", title: "Cash deposited on Base", description: "Waiting for the safe head before the engine can verify the log.", links: txLinks("base", hash) });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new RoseActionError("contract", "Deposit reverted on Base", "depositCash reverted: nothing left your wallet. Check the amount and retry.", true);
      const log = decodeCashDeposited(receipt)[0];
      if (!log) throw new RoseActionError("contract", "No CashDeposited log", "The transaction emitted no CashDeposited log.");
      recordAttempted({ key: baseLogReplayKey(log), chain: "base", label: `depositCash of ${format(parsed)} ${unit}`, nearAccount: near.accountId, attemptedAt: Date.now(), baseTx: hash, cash: { creditTo: near.accountId, roundId: roundId.toString(), token: token.toLowerCase(), amount: parsed.toString() } });
      setRecorded((count) => count + 1);
      deposit = { log, amount: parsed };
      setPending(deposit);
    } catch (error) {
      const described = toActionError(error);
      setBaseError(described);
      setFailedStep(step);
      setBaseStep("idle");
      toast.show({ tone: "error", title: described.title, description: described.message });
      return;
    }
    await registerLog(deposit);
  }, [engine, format, getEvmWalletClient, near.accountId, parsed, registerLog, roundId, toast, unit, valid, venue]);

  if (venue === "Near") {
    const wallet = balances.nearTusdc;
    const enough = wallet !== null && parsed !== null && wallet >= parsed;
    return (
      <div className="flex flex-col gap-3 rounded-md border border-ink-700 bg-ink-900 p-3" data-cash-deposit="near">
        <p className="text-[12px] text-ink-300">
          Your cash in this venue is short by <span className="tabular text-ink-50">{formatUsdc(shortfall)} tUSDC</span>. Deposit it from your NEAR wallet; it stays yours, withdrawable from the Portfolio.
        </p>
        <Field label="Amount to deposit" hint={wallet !== null ? `Wallet balance ${formatUsdc(wallet)} tUSDC` : "Reading the wallet balance…"} error={!valid ? "Enter a positive amount of tUSDC." : !enough && wallet !== null ? "Not enough tUSDC in the wallet: mint some with Get test funds, then retry." : null}>
          {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={amount} onValueChange={setAmount} unit="tUSDC" decimals={USDC_DECIMALS} />}
        </Field>
        {storageNeed ? (
          <p className="text-[12px] text-ink-400" data-storage-notice={storageNeed.kind}>
            {storageNotice(storageNeed)}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void depositNear()} disabled={!valid || !enough || near.status !== "connected"} loading={nearDeposit.state.status === "loading"} loadingLabel="Signing…" data-deposit-near>
            Deposit {valid && parsed !== null ? formatUsdc(parsed) : ""} tUSDC
          </Button>
          {!enough && wallet !== null ? <GetTestFundsButton variant="ghost" /> : null}
        </div>
        {nearDeposit.state.status === "error" ? <Notice tone="danger">{nearDeposit.state.error.message}</Notice> : null}
      </div>
    );
  }

  const baseBalance = balances.baseTusdc;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-ink-700 bg-ink-900 p-3" data-cash-deposit="base">
      <p className="text-[12px] text-ink-300">
        Your cash in this venue is short by <span className="tabular text-ink-50">{format(shortfall)} {unit}</span>. Deposit it into RoseVault from your EVM wallet; the engine confirms it in 3 to 4 minutes.
      </p>
      {restoring ? <Notice tone="info">Restoring your wallet…</Notice> : evm.status !== "connected" ? <Notice tone="warning">Connect an EVM wallet on Base Sepolia (or the demo wallet) to deposit.</Notice> : null}
      <Field label="Amount to deposit" hint={decimals === null ? `Reading the decimals of ${unit}…` : baseBalance !== null ? `Wallet balance ${formatUsdc(baseBalance)} (rose tUSDC)` : "The venue token balance is read for rose tUSDC only."} error={decimals !== null && !valid ? "Enter a positive amount." : null}>
        {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={amount} onValueChange={setAmount} unit={unit} decimals={scale} />}
      </Field>
      <ol className="flex flex-col gap-1 text-[12px]" data-base-cash-steps>
        {BASE_STEPS.map((step, index) => {
          const current = failedStep ?? baseStep;
          const order = BASE_STEPS.findIndex((s) => s.id === current);
          const state = baseStep === "done" || index < order ? "done" : index === order ? (failedStep ? "failed" : "active") : "upcoming";
          return (
            <li key={step.id} data-step={step.id} data-state={state} className={cn("flex items-center gap-2", state === "done" ? "text-success-400" : state === "active" ? "text-ember-300" : state === "failed" ? "text-danger-400" : "text-ink-400")}>
              <span aria-hidden className={cn("size-2 rounded-sm", state === "done" ? "bg-success-500" : state === "active" ? "animate-pulse bg-ember-500" : state === "failed" ? "bg-danger-500" : "bg-ink-700")} />
              {step.label}
              {state === "active" && step.id === "finality" && finality ? <span className="tabular text-ink-400">· {finality}</span> : null}
            </li>
          );
        })}
      </ol>
      {pending && baseStep !== "done" ? (
        <p className="text-[12px] text-ink-300" data-pending-cash>
          {format(pending.amount)} {unit} sits in RoseVault (
          <a href={txUrl("base", pending.log.transactionHash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            depositCash ↗
          </a>
          ) until the engine verifies the log. A retry re-sends only the registration; nothing is deposited again.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pending && baseStep === "idle" ? (
          <Button size="sm" onClick={() => void registerLog(pending)} disabled={near.status !== "connected"} data-retry-registration>
            Retry registration
          </Button>
        ) : (
          <Button size="sm" onClick={() => void depositBase()} disabled={!valid || evm.status !== "connected" || near.status !== "connected" || (baseStep !== "idle" && baseStep !== "done")} loading={baseStep !== "idle" && baseStep !== "done"} loadingLabel={BASE_STEPS.find((s) => s.id === baseStep)?.label ?? "Working…"} data-deposit-base>
            {failedStep === "approve" || failedStep === "deposit" ? "Retry the deposit" : "Deposit on Base"}
          </Button>
        )}
      </div>
      {baseError ? <Notice tone="danger">{baseError.title}: {baseError.message}</Notice> : null}
      {near.accountId ? <PendingCashDeposits token={venue.Base.token} creditTo={near.accountId} exclude={pending ? keyId(baseLogReplayKey(pending.log)) : null} refreshKey={recorded} onRegistered={onDeposited} /> : null}
    </div>
  );
}
