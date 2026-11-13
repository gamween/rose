"use client";

import { describeRoseEvent, type PayoutView } from "@rose/sdk";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/DetailsList";
import { Field, NumberInput } from "@/components/ui/Input";
import { amountToText, formatAmount, formatDate, nsToMs, parseAmount } from "@/lib/amounts";
import { CASH_ROW_BYTES, HOLDING_ROW_BYTES, STORAGE_BYTE_COST } from "@/lib/engine-storage";
import { deployedAddress } from "@/lib/deployment";
import { nearBlockUrl } from "@/lib/explorer";
import { eventAmountFormat } from "@/lib/event-format";
import { describePayout, payoutExplorerLink } from "@/lib/payouts";
import { ROUTES } from "@/lib/routes";
import type { PayoutEntry, PortfolioData } from "./data";
import { settledPayout } from "./transforms";

const NEAR_DECIMALS = 24;

function roundHref(data: Record<string, unknown>): string | null {
  return typeof data.round_id === "string" ? `${ROUTES.rounds}/${data.round_id}` : null;
}

/** The account's engine events (from the on-chain history) and its payouts, with explorer links. */
export function HistorySection({ data }: { data: PortfolioData }) {
  const [showAll, setShowAll] = useState(false);
  const events = showAll ? data.events : data.events.slice(0, 12);
  const amountFormat = eventAmountFormat((classId) => data.classes.get(classId)?.decimals ?? null);
  const executed = data.payouts.filter((entry) => settledPayout(entry.state));
  return (
    <Card data-history>
      <CardHeader title="History" description="Your recent engine events and payouts." />
      <CardBody className="flex flex-col gap-4">
        {data.events.length === 0 ? (
          <p className="text-[13px] text-ink-400">No event mentions this account in the last {400} engine events.</p>
        ) : (
          <ol className="flex flex-col divide-y divide-ink-800">
            {events.map((entry) => {
              const href = roundHref(entry.event.data as Record<string, unknown>);
              const line = describeRoseEvent(entry.event, amountFormat);
              return (
                <li key={entry.seq.toString()} className="flex items-start justify-between gap-3 py-2" data-history-event={entry.event.event}>
                  {href ? (
                    <Link href={href} className="min-w-0 text-[13px] text-ink-100 underline-offset-2 [overflow-wrap:anywhere] hover:underline">
                      {line}
                    </Link>
                  ) : (
                    <span className="min-w-0 text-[13px] text-ink-100 [overflow-wrap:anywhere]">{line}</span>
                  )}
                  <a href={nearBlockUrl(entry.blockHeight)} target="_blank" rel="noreferrer" className="tabular shrink-0 text-[11px] text-ink-400 underline-offset-2 hover:text-ink-200 hover:underline" title={`Block ${entry.blockHeight.toString()}, sent by ${entry.predecessor}`}>
                    {formatDate(nsToMs(entry.timestamp))} ↗
                  </a>
                </li>
              );
            })}
          </ol>
        )}
        {data.events.length > 12 ? (
          <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show fewer" : `Show all ${String(data.events.length)} events`}
          </Button>
        ) : null}
        {executed.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h4 className="text-[12px] text-ink-300 font-medium">Payouts</h4>
            <ul className="flex flex-col divide-y divide-ink-800">
              {executed.map((entry) => (
                <PayoutLine key={entry.payout.id} entry={entry} data={data} />
              ))}
            </ul>
          </section>
        ) : null}
      </CardBody>
    </Card>
  );
}

function PayoutLine({ entry, data }: { entry: PayoutEntry; data: PortfolioData }) {
  const payout: PayoutView = entry.payout;
  const decimalsOf = (token: string) => [...data.classes.values()].find((info) => info.token.toLowerCase() === token.toLowerCase())?.decimals ?? (data.config.base_cash_tokens.includes(token.toLowerCase()) ? 6 : null);
  const failure = typeof payout.status === "object" ? payout.status.Failed.reason : null;
  const link = payoutExplorerLink(payout, deployedAddress("roseVault"));
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12px]" data-history-payout={payout.id}>
      <span className="min-w-0 text-ink-100 [overflow-wrap:anywhere]">
        #{payout.id} · {describePayout(payout, decimalsOf, formatAmount)}
        {link ? (
          <>
            {" "}
            <a href={link.href} target="_blank" rel="noreferrer" className="text-ember-300 underline-offset-2 hover:underline">
              {link.label}
            </a>
          </>
        ) : null}
      </span>
      <span className="flex items-center gap-2 text-ink-400">
        {failure ? (
          <Badge tone="danger">Failed: {failure}</Badge>
        ) : entry.state === "lapsed" ? (
          <Badge tone="neutral">Expired, nothing debited</Badge>
        ) : (
          <Badge tone="success">Executed</Badge>
        )}
        <span className="tabular">{formatDate(nsToMs(BigInt(payout.updated_at)))}</span>
      </span>
    </li>
  );
}

/** NEP-145 storage balance of the account in the engine with deposit and withdraw. */
export function StorageSection({ data, onDeposit, onWithdraw, busy }: { data: PortfolioData; onDeposit: (amount: bigint) => void; onWithdraw: (amount: bigint | null) => void; busy: boolean }) {
  const [amount, setAmount] = useState(amountToText(data.storageMinimum, NEAR_DECIMALS));
  const parsed = parseAmount(amount, NEAR_DECIMALS);
  const registered = data.storage !== null;
  return (
    <Card data-storage>
      <CardHeader title="Storage" description="NEAR held by the engine for your rows. Actions that need more add the top-up for you." action={registered ? <Badge tone="success">Registered</Badge> : <Badge tone="warning">Not registered</Badge>} />
      <CardBody className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-[12px] text-ink-400 font-medium">Total</dt>
            <dd className="tabular text-[15px] text-ink-50">{data.storage ? `${formatAmount(data.storage.total, NEAR_DECIMALS, 5)} NEAR` : "—"}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-ink-400 font-medium">Available</dt>
            <dd className="tabular text-[15px] text-ink-50">{data.storage ? `${formatAmount(data.storage.available, NEAR_DECIMALS, 5)} NEAR` : "—"}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-ink-400 font-medium">Minimum</dt>
            <dd className="tabular text-[15px] text-ink-50">{formatAmount(data.storageMinimum, NEAR_DECIMALS, 5)} NEAR</dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Amount" className="w-44" error={parsed === null ? "Enter a NEAR amount" : undefined}>
            {({ inputId, invalid }) => <NumberInput id={inputId} value={amount} onValueChange={setAmount} unit="NEAR" decimals={NEAR_DECIMALS} invalid={invalid} />}
          </Field>
          <Button size="md" variant="secondary" disabled={parsed === null || parsed === 0n || busy} onClick={() => parsed !== null && onDeposit(parsed)} data-storage-deposit>
            {registered ? "Top up" : "Register"}
          </Button>
          <Button size="md" variant="ghost" disabled={!registered || busy || (data.storage?.available ?? 0n) === 0n} title={!registered ? "Not registered" : (data.storage?.available ?? 0n) === 0n ? "Nothing available to withdraw" : undefined} onClick={() => onWithdraw(parsed !== null && parsed > 0n ? parsed : null)} data-storage-withdraw>
            Withdraw {parsed !== null && parsed > 0n ? "amount" : "all available"}
          </Button>
        </div>
        <Disclosure summary="What storage pays for">
          <p className="text-[12.5px] leading-relaxed text-ink-300">
            NEP-145 storage. The minimum covers your account, one class and one cash venue; each further class held costs {formatAmount(HOLDING_ROW_BYTES * STORAGE_BYTE_COST, NEAR_DECIMALS, 5)} NEAR and each further cash venue {formatAmount(CASH_ROW_BYTES * STORAGE_BYTE_COST, NEAR_DECIMALS, 5)} NEAR. Receiving units, buying in an Exit, depositing NEAR cash or getting a distribution needs room for the row.
          </p>
        </Disclosure>
      </CardBody>
    </Card>
  );
}
