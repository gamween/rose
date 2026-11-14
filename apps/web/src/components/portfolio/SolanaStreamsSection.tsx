"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/DetailsList";
import { formatAmount, formatDate, formatDuration, secondsToMs, shortHex } from "@/lib/amounts";
import { solanaAddressUrl } from "@/lib/explorer";
import { classLabel } from "@/lib/token-symbols";
import type { PortfolioData, SolClassView, SolStreamRow } from "./data";
import { syncBlocker, type SolStreamPhase } from "./transforms";

const PHASE: Record<SolStreamPhase, { text: string; tone: "neutral" | "ember" | "success" | "warning" }> = {
  open: { text: "Pays claims", tone: "success" },
  drawing: { text: "Payout unconfirmed", tone: "ember" },
  closing: { text: "No draws: ends soon", tone: "warning" },
  ended: { text: "Ended", tone: "neutral" },
};

function phaseHint(row: SolStreamRow, nowSec: bigint, decimals: number): string {
  const stream = row.entry.stream;
  const end = BigInt(stream.end_time);
  switch (row.phase) {
    case "open":
      return `${formatAmount(BigInt(row.entry.withdrawable), decimals)} withdrawable now. Draws stop 5 minutes before the end (in ${formatDuration(Number(end - 300n - nowSec))}).`;
    case "drawing":
      return `Payout #${stream.drawing ?? ""} draws on it and is not confirmed yet: nothing else draws on it until it is.`;
    case "closing":
      return `Ends in ${formatDuration(Number(end - nowSec))}: a payout drawing on it now could reach Solana after the end, when Streamflow's auto-claim has already emptied it, so it takes no draw and no redeem. After the end, sync it.`;
    case "ended": {
      const toSync = row.onChainWithdrawn !== null && row.onChainWithdrawn > BigInt(stream.engine_withdrawn) ? row.onChainWithdrawn - BigInt(stream.engine_withdrawn) : 0n;
      return toSync > 0n
        ? `Streamflow's auto-claim moved ${formatAmount(toSync, decimals)} into the vault's token account; Sync books it in the swept balance.`
        : "Streamflow's auto-claim moves the remainder into the vault's token account one second after the end; Sync books it once it is final.";
    }
  }
}

function StreamItem({ row, decimals, nowSec, onSync }: { row: SolStreamRow; decimals: number; nowSec: bigint; onSync: (row: SolStreamRow) => void }) {
  const stream = row.entry.stream;
  const phase = PHASE[row.phase];
  const blocker = row.phase === "ended" ? syncBlocker(stream, row.onChainWithdrawn) : undefined;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2 sm:flex-row sm:items-center sm:justify-between" data-sol-stream={row.entry.position_id} data-sol-stream-phase={row.phase}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-50">
          <span>Position #{row.entry.position_id}</span>
          <a href={solanaAddressUrl(stream.metadata)} target="_blank" rel="noreferrer" className="font-mono text-ink-300 underline-offset-2 hover:underline">
            {shortHex(stream.metadata, 6, 6)} ↗
          </a>
          <Badge tone={phase.tone}>{phase.text}</Badge>
        </p>
        <p className="text-[12px] text-ink-400">
          Ends {formatDate(secondsToMs(stream.end_time))} · {formatAmount(BigInt(stream.engine_withdrawn), decimals)} of {formatAmount(BigInt(stream.net_amount_deposited), decimals)} withdrawn by the engine
        </p>
        <p className="text-[12px] text-ink-400" data-sol-stream-hint>
          {phaseHint(row, nowSec, decimals)}
        </p>
        {blocker ? (
          <p className="text-[12px] text-ink-300" data-sync-blocker>
            {blocker}
          </p>
        ) : null}
      </div>
      {row.phase === "ended" ? (
        <Button size="sm" variant={blocker ? "secondary" : "primary"} disabled={blocker !== undefined} onClick={() => onSync(row)} className="self-start sm:self-center" data-sync>
          Sync
        </Button>
      ) : null}
    </li>
  );
}

function ClassBlock({ view, data, onSync }: { view: SolClassView; data: PortfolioData; onSync: (view: SolClassView, row: SolStreamRow) => void }) {
  const info = data.classes.get(view.classId);
  if (!info) return null;
  const symbol = classLabel(info, data.symbols);
  return (
    <section className="flex flex-col gap-2" data-sol-class={view.classId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[12px] text-ink-300 font-medium">{symbol}</h4>
        <p className="tabular text-[12px] text-ink-300" data-swept>
          Swept balance {formatAmount(view.swept.available, info.decimals)} {symbol}
          {view.swept.pending > 0n ? ` (+ ${formatAmount(view.swept.pending, info.decimals)} reserved by unconfirmed payouts)` : ""}
        </p>
      </div>
      {view.streams.length === 0 ? (
        <p className="text-[12px] text-ink-400">No vault stream left in this class: claims pay from the swept balance.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.streams.map((row) => (
            <StreamItem key={row.entry.position_id} row={row} decimals={info.decimals} nowSec={data.blockTimeSec} onSync={(selected) => onSync(view, selected)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The vault streams of the account's Solana classes and each class's swept balance (spec 7.3):
 * which streams pay claims now, the 5-minute window before an end in which none does, and the
 * Sync of an ended stream that books Streamflow's auto-claim so claims can pay it.
 */
export function SolanaStreamsSection({ data, onSync }: { data: PortfolioData; onSync: (view: SolClassView, row: SolStreamRow) => void }) {
  const classes = data.solClasses.filter((view) => view.streams.length > 0 || view.swept.balance > 0n);
  if (classes.length === 0) return null;
  return (
    <Card data-sol-streams>
      <CardHeader
        title="Solana streams"
        description="Solana claims draw on these vault streams. Anyone can sync an ended stream."
      />
      <CardBody className="flex flex-col gap-4">
        {classes.map((view) => (
          <ClassBlock key={view.classId} view={view} data={data} onSync={onSync} />
        ))}
        <Disclosure summary="How Solana streams pay claims">
          <p className="text-[12.5px] leading-relaxed text-ink-300">
            Claims draw on these vault streams, except from 5 minutes before a stream&apos;s end. One second after the end, Streamflow&apos;s auto-claim moves the remainder into the vault&apos;s token account; Sync proves it on NEAR and books it in the class&apos;s swept balance, which claims then pay from automatically.
          </p>
        </Disclosure>
      </CardBody>
    </Card>
  );
}
