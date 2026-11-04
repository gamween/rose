"use client";

/**
 * Funds the viewer's cash in the round's venue before an order (spec 5.4 cash venue). NEAR
 * venue: the storage deposit the account misses for its cash row (spec 4), then
 * `ft_transfer_call` of tUSDC into the engine, from one button. Base venue: `approve` and
 * `RoseVault.depositCash` with the connected EVM wallet, wait for Base's safe head, then
 * `register_base_cash` so the engine verifies the log through the MPC and credits the ledger
 * (it pays the cash row out of its record deposit).
 */

import { approveToken, decodeCashDeposited, depositCash, registerBaseCashArgs, waitForSafeHead, type Venue } from "@rose/sdk";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, NumberInput } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useWallets } from "@/components/wallet/WalletProvider";
import { amountToText } from "@/lib/amounts";
import { cn } from "@/lib/cn";
import { deployedAddress } from "@/lib/deployment";
import { toActionError, type ActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { depositNearCash, storageNotice, useNearCashStorageNeed } from "@/lib/near-cash";
import { useAction } from "@/lib/use-action";
import { basePublicClient } from "@/lib/wallet/evm-demo";
import { useNearAction } from "./actions";
import type { RoundsEngine } from "./engine";
import { addReceipt } from "./localOrders";
import { formatUsdc, parseDecimal, USDC_DECIMALS } from "./model";
import { Notice } from "./shared";

type BaseStep = "idle" | "approve" | "deposit" | "finality" | "register" | "done";

const BASE_STEPS: { id: BaseStep; label: string }[] = [
  { id: "approve", label: "Approve the vault" },
  { id: "deposit", label: "depositCash on RoseVault" },
  { id: "finality", label: "Wait for Base safe head" },
  { id: "register", label: "register_base_cash (MPC proof)" },
];

export function CashDeposit({ engine, venue, roundId, shortfall, nearCashToken, onDeposited }: { engine: RoundsEngine; venue: Venue; roundId: bigint; shortfall: bigint; nearCashToken: string; onDeposited: () => void }) {
  const { near, evm, balances, getEvmWalletClient, refreshBalances, sendNearCall } = useWallets();
  const toast = useToast();
  const { run } = useNearAction();
  const nearDeposit = useAction();
  const storageNeed = useNearCashStorageNeed(venue === "Near" ? engine : null, near.accountId, nearDeposit.state.status);
  const [editedAmount, setAmount] = useState<string | null>(null);
  /** The shortfall until the viewer types another amount (a plain decimal: the field parses no separators). */
  const amount = editedAmount ?? amountToText(shortfall, USDC_DECIMALS);
  const [baseStep, setBaseStep] = useState<BaseStep>("idle");
  const [baseError, setBaseError] = useState<ActionError | null>(null);
  const [finality, setFinality] = useState<string | null>(null);
  const parsed = parseDecimal(amount, USDC_DECIMALS);
  const valid = parsed !== null && parsed > 0n;

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

  const depositBase = useCallback(async () => {
    if (!valid || parsed === null || venue === "Near") return;
    const vault = deployedAddress("roseVault");
    if (!vault) {
      setBaseError({ kind: "not_deployed", title: "RoseVault not deployed", message: "The Base venue needs RoseVault; it is not deployed yet.", retryable: false });
      return;
    }
    if (!near.accountId) return;
    setBaseError(null);
    const token = venue.Base.token as `0x${string}`;
    const client = basePublicClient();
    try {
      const wallet = await getEvmWalletClient();
      setBaseStep("approve");
      const approveHash = await approveToken(wallet, token, vault, parsed);
      addReceipt(engine.account, roundId, { kind: "cash", chain: "base", hash: approveHash, at: Date.now(), label: "approve" });
      await client.waitForTransactionReceipt({ hash: approveHash });
      setBaseStep("deposit");
      const hash = await depositCash(wallet, { vault, token, amount: parsed, nearAccount: near.accountId, roundId });
      addReceipt(engine.account, roundId, { kind: "cash", chain: "base", hash, at: Date.now(), label: "depositCash" });
      toast.show({ tone: "info", title: "Cash deposited on Base", description: "Waiting for the safe head before the engine can verify the log.", links: txLinks("base", hash) });
      const receipt = await client.waitForTransactionReceipt({ hash });
      const log = decodeCashDeposited(receipt)[0];
      if (!log) throw new Error("The transaction emitted no CashDeposited log.");
      setBaseStep("finality");
      await waitForSafeHead(client, receipt.blockNumber, {
        onProgress: (p) => setFinality(p.phase === "waiting_safe" ? `safe head ${p.safeHead.toString()} / ${p.target.toString()}` : p.phase === "margin" ? "safe head passed, 30 s margin for the MPC providers" : "ready"),
      });
      setBaseStep("register");
      const args = registerBaseCashArgs(log);
      const result = await run({
        label: "Registering the Base cash deposit (MPC verification, about 10 s)",
        call: engine.calls.registerBaseCash(args.location, { ...args.fields }),
        success: `${formatUsdc(parsed)} credited to your Base cash`,
        receipt: { engine: engine.account, roundId, kind: "cash", label: "register_base_cash" },
      });
      if (!result.ok) {
        setBaseError(result.error);
        setBaseStep("idle");
        return;
      }
      setBaseStep("done");
      void refreshBalances();
      onDeposited();
    } catch (error) {
      const described = toActionError(error);
      setBaseError(described);
      setBaseStep("idle");
      toast.show({ tone: "error", title: described.title, description: described.message });
    }
  }, [engine, getEvmWalletClient, near.accountId, onDeposited, parsed, refreshBalances, roundId, run, toast, valid, venue]);

  if (venue === "Near") {
    const wallet = balances.nearTusdc;
    const enough = wallet !== null && parsed !== null && wallet >= parsed;
    return (
      <div className="flex flex-col gap-3 rounded-md border border-ink-700 bg-ink-900 p-3" data-cash-deposit="near">
        <p className="text-[12px] text-ink-300">
          Your cash in this venue is short by <span className="tabular text-ink-50">{formatUsdc(shortfall)} tUSDC</span>. Deposit tUSDC from your NEAR wallet into the engine (`ft_transfer_call`); it stays yours and is withdrawable from the Portfolio.
        </p>
        <Field label="Amount to deposit" hint={wallet !== null ? `Wallet balance ${formatUsdc(wallet)} tUSDC` : "Reading the wallet balance…"} error={!valid ? "Enter a positive amount of tUSDC." : !enough && wallet !== null ? "Not enough tUSDC in the wallet: mint some with “Get test funds” in the banner, then retry." : null}>
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
        </div>
        {nearDeposit.state.status === "error" ? <Notice tone="danger">{nearDeposit.state.error.message}</Notice> : null}
      </div>
    );
  }

  const baseBalance = balances.baseTusdc;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-ink-700 bg-ink-900 p-3" data-cash-deposit="base">
      <p className="text-[12px] text-ink-300">
        Your cash in this venue is short by <span className="tabular text-ink-50">{formatUsdc(shortfall)}</span>. Deposit the Base token into RoseVault with your EVM wallet; the engine verifies the `CashDeposited` log through the MPC once Base&apos;s safe head passes it (3 to 4 minutes).
      </p>
      {evm.status !== "connected" ? <Notice tone="warning">Connect an EVM wallet on Base Sepolia (or the demo wallet) to deposit.</Notice> : null}
      <Field label="Amount to deposit" hint={baseBalance !== null ? `Wallet balance ${formatUsdc(baseBalance)} (rose tUSDC)` : "The venue token balance is read for rose tUSDC only."} error={!valid ? "Enter a positive amount." : null}>
        {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={amount} onValueChange={setAmount} unit="USDC" decimals={USDC_DECIMALS} />}
      </Field>
      <ol className="flex flex-col gap-1 text-[12px]">
        {BASE_STEPS.map((step, index) => {
          const order = BASE_STEPS.findIndex((s) => s.id === baseStep);
          const state = baseStep === "done" || index < order ? "done" : index === order ? "active" : "upcoming";
          return (
            <li key={step.id} className={cn("flex items-center gap-2", state === "done" ? "text-success-400" : state === "active" ? "text-ember-300" : "text-ink-400")}>
              <span aria-hidden className={cn("size-2 rounded-sm", state === "done" ? "bg-success-500" : state === "active" ? "animate-pulse bg-ember-500" : "bg-ink-700")} />
              {step.label}
              {state === "active" && step.id === "finality" && finality ? <span className="tabular text-ink-400">· {finality}</span> : null}
            </li>
          );
        })}
      </ol>
      <div>
        <Button size="sm" onClick={() => void depositBase()} disabled={!valid || evm.status !== "connected" || near.status !== "connected" || (baseStep !== "idle" && baseStep !== "done")} loading={baseStep !== "idle" && baseStep !== "done"} loadingLabel={BASE_STEPS.find((s) => s.id === baseStep)?.label ?? "Working…"}>
          Deposit on Base
        </Button>
      </div>
      {baseError ? <Notice tone="danger">{baseError.message}</Notice> : null}
    </div>
  );
}
