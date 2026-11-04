"use client";

import { ONE_YOCTO, type ClassInfo } from "@rose/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Input, NumberInput } from "@/components/ui/Input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatAmount } from "@/lib/amounts";
import { txLinks } from "@/lib/explorer";
import { useFlow } from "@/lib/use-action";
import { checkRows, distributionDeposit, parseAllocationLines, rowsTotal, splitBatches, type AllocationRow } from "./allocations";
import { ClassPicker, ClassSummary, classSymbol, FieldLabel, formatNear, Hint, Preview, type IssuerBase } from "./shared";

type Deposits = { perReceiver: Map<string, bigint>; total: bigint };

/** Tab 3: `distribute_units` from the issuer's free balance, with the receivers' registrations attached. */
export function DistributeTab({ base, initialClassId }: { base: IssuerBase; initialClassId?: string }) {
  const wallets = useWallets();
  const [classId, setClassId] = useState(initialClassId ?? base.classes[0]?.classId ?? "");
  const cls: ClassInfo | null = base.classes.find((item) => item.classId === classId) ?? null;
  const [rows, setRows] = useState<AllocationRow[]>([{ account: "", amount: "" }]);
  const [paste, setPaste] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [deposits, setDeposits] = useState<Deposits | null>(null);
  const flow = useFlow();
  const decimals = cls?.decimals ?? 18;
  const checked = useMemo(() => checkRows(rows, decimals, null), [rows, decimals]);
  const total = rowsTotal(checked);
  const valid = checked.length > 0 && checked.every((row) => row.error === null);
  const batches = useMemo(() => splitBatches(checked.filter((row) => row.error === null), base.limits.maxDistributionReceivers), [checked, base.limits.maxDistributionReceivers]);

  useEffect(() => {
    let cancelled = false;
    const account = wallets.near.accountId;
    const timer = window.setTimeout(() => {
      if (!cls || !account) {
        setBalance(null);
        return;
      }
      void base.engine.views
        .getHolding(account, cls.classId)
        .then((holding) => {
          if (!cancelled) setBalance(holding.balance);
        })
        .catch(() => {
          if (!cancelled) setBalance(null);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base.engine, cls, wallets.near.accountId, flow.completed]);

  const computeDeposits = useCallback(async () => {
    if (!cls || !valid) {
      setDeposits(null);
      return;
    }
    const perReceiver = new Map<string, bigint>();
    await Promise.all(
      checked.map(async (row) => {
        const amount = await base.engine.views.registrationDepositFor(row.account, cls.classId);
        perReceiver.set(row.account, distributionDeposit(amount));
      }),
    );
    setDeposits({ perReceiver, total: [...perReceiver.values()].reduce((sum, value) => sum + value, 0n) });
  }, [base.engine, checked, cls, valid]);

  useEffect(() => {
    const timer = window.setTimeout(() => void computeDeposits(), 400);
    return () => window.clearTimeout(timer);
  }, [computeDeposits]);

  const updateRow = (index: number, patch: Partial<AllocationRow>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const distribute = async () => {
    if (!cls || !valid || !deposits) return;
    await flow.start(
      batches.map((batch, index) => ({
        id: `batch-${String(index)}`,
        label: batches.length === 1 ? `Distribute to ${String(batch.length)} receiver(s)` : `Batch ${String(index + 1)}/${String(batches.length)}: ${String(batch.length)} receiver(s)`,
        run: async () => {
          const registration = batch.reduce((sum, row) => sum + (deposits.perReceiver.get(row.account) ?? 0n), 0n);
          const outcome = await wallets.sendNearCall(base.engine.calls.distributeUnits(cls.classId, batch.map((row) => ({ account: row.account, units: row.amountUnits ?? 0n })), registration > 0n ? registration : ONE_YOCTO));
          return { message: `${formatAmount(batch.reduce((sum, row) => sum + (row.amountUnits ?? 0n), 0n), cls.decimals)} units distributed`, links: txLinks("near", outcome.transaction.hash) };
        },
      })),
    );
  };

  const disabledReason = !wallets.near.accountId ? "Connect a NEAR wallet (the issuer)." : !cls ? "Choose a class." : !valid ? "Fix the receivers." : balance !== null && balance < total ? `Your free balance (${formatAmount(balance, cls.decimals)} units) is below the total.` : deposits === null ? "Computing the registration deposits…" : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Distribute units" description="One bounded batch transfer per call (NEP-245 events), from your free units of the class to the cohort's NEAR accounts. Accrual follows the units from the moment they are received." />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="distribute-class">Class</FieldLabel>
            <ClassPicker id="distribute-class" classes={base.classes} symbols={base.symbols} value={classId} onChange={setClassId} />
            {cls ? <Hint>{balance === null ? "Your free balance is read once a NEAR wallet is connected." : `Your free balance: ${formatAmount(balance, cls.decimals)} units (${classSymbol(cls, base.symbols)}).`}</Hint> : <Hint>No class yet: register the cohort first.</Hint>}
          </div>
          <div className="flex flex-col gap-2">
            <FieldLabel>Receivers (NEAR account, units)</FieldLabel>
            <Table>
              <THead>
                <TR>
                  <TH>Receiver</TH>
                  <TH numeric>Units</TH>
                  <TH numeric>Registration</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {checked.map((row, index) => (
                  <TR key={index}>
                    <TD className="min-w-48">
                      <Input value={row.account} onChange={(event) => updateRow(index, { account: event.target.value })} placeholder="holder.testnet" aria-label={`Receiver ${String(index + 1)}`} />
                      {row.error ? <span className="text-[11px] text-danger-400">{row.error}</span> : null}
                    </TD>
                    <TD numeric className="min-w-32">
                      <NumberInput value={row.amount} onValueChange={(value) => updateRow(index, { amount: value })} decimals={decimals} aria-label={`Units ${String(index + 1)}`} />
                    </TD>
                    <TD numeric className="text-[12px] text-ink-400">{deposits?.perReceiver.has(row.account) ? (deposits.perReceiver.get(row.account) === 0n ? "registered" : `${formatNear(deposits.perReceiver.get(row.account) ?? 0n)} NEAR`) : "—"}</TD>
                    <TD numeric>
                      <Button size="sm" variant="ghost" onClick={() => setRows((current) => current.filter((_, i) => i !== index))} aria-label={`Remove receiver ${String(index + 1)}`}>
                        ×
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setRows((current) => [...current, { account: "", amount: "" }])}>
                Add a receiver
              </Button>
              <span className="text-[12px] text-ink-400">or paste `account,units` lines:</span>
            </div>
            <textarea
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              onBlur={() => {
                const parsed = parseAllocationLines(paste);
                if (parsed.length > 0) {
                  setRows(parsed);
                  setPaste("");
                }
              }}
              rows={3}
              placeholder={"halden.testnet,1000\ntessaro.testnet,1500"}
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-[12px] text-ink-50 placeholder:text-ink-400 focus:border-ember-500 focus:outline-none"
              aria-label="Paste receivers"
            />
          </div>
          <Preview
            rows={[
              { label: "Receivers", value: `${String(checked.length)} in ${String(batches.length)} call(s) (max ${String(base.limits.maxDistributionReceivers)} per call)` },
              { label: "Units distributed", value: cls ? `${formatAmount(total, cls.decimals)} ${classSymbol(cls, base.symbols)} units` : "—", emphasis: true },
              { label: "Registration deposits attached", value: deposits ? `${formatNear(deposits.total)} NEAR (unused part refunded)` : "—" },
            ]}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void distribute()} disabled={disabledReason !== null || flow.running} loading={flow.running} loadingLabel="Distributing" title={disabledReason ?? undefined} data-distribute>
              Distribute
            </Button>
            {disabledReason ? <Hint>{disabledReason}</Hint> : null}
          </div>
          <p className="text-[12px] text-ink-400">
            Receivers that never touched the engine are registered (NEP-145) with the attached deposit. <LearnMore topic="issuer" anchor="2-create-the-cohorts-positions-and-distribute-units" />
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Class and progress" />
        <CardBody className="flex flex-col gap-4">
          {cls ? <ClassSummary cls={cls} symbols={base.symbols} /> : <p className="text-[13px] text-ink-400">Choose a class to see its schedule and supply.</p>}
          <FlowSteps steps={flow.steps} onRetry={() => void flow.retry()} running={flow.running} />
        </CardBody>
      </Card>
    </div>
  );
}
