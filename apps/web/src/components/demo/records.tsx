"use client";

/**
 * The evidence under each demo step: its transactions with explorer links on NEAR testnet, Base
 * Sepolia and Solana devnet (from the committed manifest), and the engine's own history entries
 * for the step (read live with `get_events`).
 */

import { describeRoseEvent, type EventAmountFormat, type StoredEvent } from "@rose/sdk";
import type { DemoTx } from "@/lib/demo/manifest";
import { eventAmountFormat } from "@/lib/event-format";
import { CHAIN_LABEL, txLinks } from "@/lib/explorer";
import { cn } from "@/lib/cn";
import { formatDateTime, formatUsdc, nsToMs } from "@/components/rounds/model";

const CHAIN_TONE: Record<DemoTx["chain"], string> = {
  near: "border-ink-500 text-ink-100",
  base: "border-info-400/50 text-info-400",
  solana: "border-rose-600 text-rose-300",
};

export function ChainTag({ chain, className }: { chain: DemoTx["chain"]; className?: string }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-sm border px-1.5 text-[11px] font-medium", CHAIN_TONE[chain], className)}>{CHAIN_LABEL[chain]}</span>;
}

function cost(tx: DemoTx): string | null {
  if (tx.gasTgas !== null) return `${tx.gasTgas.toFixed(1)} Tgas`;
  if (tx.gasUsed !== null) return `${Number(tx.gasUsed).toLocaleString("en-US")} gas`;
  return tx.note;
}

export function TxList({ txs }: { txs: readonly DemoTx[] }) {
  return (
    <section aria-label="Transactions" className="ui-surface rounded-lg" data-demo-txs>
      <h3 className="border-b border-ink-750 px-4 py-2.5 text-[12px] text-ink-300 font-medium">
        {txs.length === 1 ? "1 transaction" : `${String(txs.length)} transactions`}
      </h3>
      <ol className="flex flex-col divide-y divide-ink-800">
        {txs.map((tx) => {
          const [primary, ...more] = txLinks(tx.chain, tx.hash);
          const spent = cost(tx);
          return (
            <li key={`${tx.chain}:${tx.hash}`} className="flex flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3" data-demo-tx={tx.chain}>
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <ChainTag chain={tx.chain} className="mt-px" />
                <span className="min-w-0 text-[13px] leading-snug text-ink-100 [overflow-wrap:anywhere]">
                  {tx.label}
                  {tx.failed ? (
                    <span className="ml-2 inline-flex items-center rounded-sm border border-warning-400/40 bg-warning-400/10 px-1.5 text-[11px] text-warning-400 font-medium" title={tx.note ?? undefined}>
                      refused on chain, as intended
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {spent && !tx.failed ? <span className="tabular text-[11px] text-ink-400">{spent}</span> : null}
                {primary ? (
                  <a href={primary.href} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-ember-300 underline-offset-2 hover:underline" title={tx.hash}>
                    {tx.hash.slice(0, 8)}… ↗
                  </a>
                ) : null}
                {more.map((link) => (
                  <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="text-[11px] text-ink-400 underline-offset-2 hover:text-ink-200 hover:underline">
                    {link.label}
                  </a>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function EventList({ events, decimals, classId, emptyHint }: { events: readonly StoredEvent[]; decimals: number; classId: string; emptyHint: string }) {
  const units = eventAmountFormat((id) => (id === classId ? decimals : null));
  const format: EventAmountFormat = { units: units.units, cash: (amount) => (/^\d+$/.test(amount) ? `${formatUsdc(BigInt(amount))} USDC` : amount) };
  return (
    <section aria-label="On-chain history" className="ui-surface rounded-lg" data-demo-events>
      <h3 className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-750 px-4 py-2.5">
        <span className="text-[12px] text-ink-300 font-medium">Engine history</span>
        <span className="text-[11px] text-ink-400">get_events, read live</span>
      </h3>
      {events.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-ink-400">{emptyHint}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-ink-800">
          {events.map((entry) => (
            <li key={entry.seq.toString()} className="flex flex-col gap-0.5 px-4 py-2 text-[12px] sm:flex-row sm:items-baseline sm:gap-3" data-demo-event={entry.event.event}>
              <span className="tabular w-14 shrink-0 text-ink-400">#{entry.seq.toString()}</span>
              <span className="min-w-0 flex-1 text-ink-200 [overflow-wrap:anywhere]">{describeRoseEvent(entry.event, format)}</span>
              <span className="tabular shrink-0 text-[11px] text-ink-400">
                block {entry.blockHeight.toString()} · {formatDateTime(nsToMs(entry.timestamp)).replace(" UTC", "")}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
