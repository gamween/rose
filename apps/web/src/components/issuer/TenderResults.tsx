"use client";

import { type Bid, type ClassInfo, type Round, type RoundResult, type StoredEvent } from "@rose/sdk";
import Link from "next/link";
import { useCallback, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatAmount, formatDate, formatDuration, formatFraction, formatUsdc, nsToMs, venueLabel } from "@/lib/amounts";
import { requireEngine } from "@/lib/engine-client";
import { nearAccountUrl } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";
import { useEngineQuery } from "@/lib/use-engine-query";
import { readEventRange } from "@/lib/event-pages";
import { askOrders, candidateTable, eventsOfRound, isFinalRound, pricingOf, recompute, tenderReportCsv, type TenderReportData } from "./report";
import { classSymbol, downloadFile, resolveSymbols } from "./shared";

const EVENTS_PAGE = 200;
/** A final round is re-read every 10 minutes instead of every 20 s (each read pages the whole event history). */
const FINAL_POLL_MS = 600_000;

type Loaded = TenderReportData & { symbols: Map<string, string> };

/** Events already read in this tab, so the 20 s refresh does not re-read the whole history (up to 1,024 events). */
let eventCache: { engine: string; next: bigint; events: StoredEvent[] } | null = null;

async function fetchReport(roundId: bigint, signal: AbortSignal): Promise<Loaded> {
  const engine = requireEngine();
  const round: Round | null = await engine.views.getRound(roundId, { signal });
  if (!round) throw new Error(`Round #${roundId.toString()} does not exist on ${engine.account}.`);
  if (round.kind !== "Tender") throw new Error(`Round #${roundId.toString()} is an ${round.kind} round, not a Tender.`);
  const [cls, bids, result, probe] = await Promise.all([engine.views.getClass(round.classId, { signal }), engine.views.getBids(roundId, { signal }), engine.views.getRoundResult(roundId, { signal }), engine.views.getEvents(undefined, 1, { signal })]);
  if (!cls) throw new Error("The round's class is missing.");
  // The history is append-only: each refresh reads only the events recorded since the last one (and drops what the ring buffer evicted).
  const cached = eventCache?.engine === engine.account ? eventCache : { engine: engine.account, next: probe.oldest, events: [] as StoredEvent[] };
  let events = cached.events.filter((entry) => entry.seq >= probe.oldest);
  for (let next = cached.next > probe.oldest ? cached.next : probe.oldest; next < probe.total; next += BigInt(EVENTS_PAGE)) {
    const page = await readEventRange((fromSeq, limit) => engine.views.getEvents(fromSeq, limit, { signal }), next, EVENTS_PAGE);
    events = [...events, ...page.events];
  }
  eventCache = { engine: engine.account, next: probe.total, events };
  const symbols = await resolveSymbols([cls]);
  return { engine: engine.account, round, cls, symbol: classSymbol(cls, symbols), bids, result, events: eventsOfRound(events, roundId), generatedAt: Date.now(), symbols };
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="flex flex-col gap-3 break-inside-avoid">
      <h2 className="font-display text-[13px] uppercase tracking-wide text-ink-200">{title}</h2>
      {children}
    </section>
  );
}

function ReportBody({ data, printable }: { data: Loaded; printable: boolean }) {
  const { round, cls, bids, result, symbol } = data;
  const pricing = pricingOf(round, cls);
  const asks = askOrders(bids);
  const budget = round.budget ?? 0n;
  const candidates = candidateTable(asks, budget, round.maxPrice, pricing);
  const recomputed = recompute(asks, budget, round.maxPrice, pricing, result);
  const unitLabel = `${symbol} units`;
  return (
    <div className="flex flex-col gap-6" data-tender-report>
      <Section title="Parameters">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-3 min-[420px]:grid-cols-2 sm:grid-cols-4">
          <Stat label="Budget" value={formatUsdc(budget)} unit="USDC" />
          <Stat label="Max price" value={formatUsdc(round.maxPrice, 4)} unit="USDC" hint="per whole locked token" />
          <Stat label="Reference price" value={round.referencePrice === null ? "none" : formatUsdc(round.referencePrice, 4)} unit={round.referencePrice === null ? undefined : "USDC"} hint={round.referencePrice === null ? "not declared" : "issuer-declared, display only"} />
          <Stat label="Remaining lock at settlement" value={formatDuration(Number(round.remainingLockSecs))} hint={`f(ts) = ${formatFraction(round.fTs, 2)}`} />
        </dl>
        <Table>
          <TBody>
            {[
              ["Round", `#${round.roundId.toString()} (${round.status}${round.cancelReason ? `, ${round.cancelReason}` : ""})`],
              ["Class", `${symbol} on ${cls.chain}, ${String(cls.decimals)} decimals, id ${round.classId}`],
              ["Cash venue", venueLabel(round.venue, data.symbols)],
              ["Issuer", round.creator],
              ["Retired units pay to", round.retireTo ?? "—"],
              ["Window (UTC)", `${formatDate(nsToMs(round.opensAt))} → ${formatDate(nsToMs(round.closesAt))}`],
              ["Key", round.key ? `${round.keySource ?? ""} at ${round.keyReceivedAt ? formatDate(nsToMs(round.keyReceivedAt)) : "—"}` : "not released"],
              ["Issuer escrow", round.issuerEscrow === null ? "—" : `${formatUsdc(round.issuerEscrow)} USDC (budget + 30 bps)`],
            ].map(([label, value]) => (
              <TR key={label}>
                <TD className="w-48 text-ink-400">{label}</TD>
                <TD className="break-all">{value}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Section>
      <Section title="Sealed book before close">
        <dl className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-3">
          <Stat label="Sealed asks" value={bids.length} />
          <Stat label="Locked units" value={formatAmount(bids.reduce((sum, bid) => sum + bid.lockedUnits, 0n), cls.decimals)} hint={unitLabel} />
          <Stat label="Bonds" value={formatUsdc(bids.reduce((sum, bid) => sum + bid.bond, 0n))} unit="USDC" />
        </dl>
      </Section>
      <Section title="Opened asks">
        {bids.length === 0 ? (
          <p className="text-[13px] text-ink-400">No ask was placed.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>#</TH>
                <TH>Seller</TH>
                <TH numeric>Locked</TH>
                <TH numeric>Quantity</TH>
                <TH numeric>Min price</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {bids.map((bid: Bid) => (
                <TR key={bid.bidId}>
                  <TD className="tabular">{bid.bidId}</TD>
                  <TD>{bid.bidder}</TD>
                  <TD numeric>{formatAmount(bid.lockedUnits, cls.decimals)}</TD>
                  <TD numeric>{bid.opened ? formatAmount(bid.opened.quantity, cls.decimals) : "sealed"}</TD>
                  <TD numeric>{bid.opened ? formatUsdc(bid.opened.price, 4) : "sealed"}</TD>
                  <TD>{bid.void ? <Badge tone="danger">void: {bid.void}</Badge> : <Badge tone={bid.status === "Settled" ? "success" : "neutral"}>{bid.status}</Badge>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
      <Section title="Candidate prices (recomputed in the browser)">
        <p className="text-[12px] text-ink-400">
          Candidates are the opened asks at or below the max price. S(P) is the quantity asked at or below P, Q(P) = min(S(P), budget ÷ P). P* maximizes Q, ties to the lowest price. <LearnMore topic="clearing" />
        </p>
        {candidates.length === 0 ? (
          <p className="text-[13px] text-ink-400">No candidate price: no opened ask at or below the max price.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH numeric>P</TH>
                <TH numeric>S(P)</TH>
                <TH numeric>Affordable</TH>
                <TH numeric>Q(P)</TH>
                <TH>P*</TH>
              </TR>
            </THead>
            <TBody>
              {candidates.map((row) => (
                <TR key={row.price.toString()} data-candidate={row.best ? "best" : "other"}>
                  <TD numeric>{formatUsdc(row.price, 4)}</TD>
                  <TD numeric>{formatAmount(row.supply, cls.decimals)}</TD>
                  <TD numeric>{formatAmount(row.affordable, cls.decimals)}</TD>
                  <TD numeric>{formatAmount(row.volume, cls.decimals)}</TD>
                  <TD>{row.best ? <Badge tone="ember">P*</Badge> : null}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <p className="text-[12px]" data-recompute={recomputed.matches === null ? "pending" : recomputed.matches ? "match" : "mismatch"}>
          {recomputed.outcome === "no_crossing" ? (
            <span className="text-ink-300">Reference clearing: no crossing{recomputed.matches === false ? " (the engine disagrees: check the opened asks)" : ""}.</span>
          ) : (
            <span className={recomputed.matches === false ? "text-danger-400" : "text-success-400"}>
              Reference clearing: P* = {formatUsdc(recomputed.price, 4)} USDC, volume {formatAmount(recomputed.volume, cls.decimals)}, charged {formatUsdc(recomputed.charged)} USDC, refund {formatUsdc(recomputed.refund)} USDC
              {recomputed.matches === null ? " (not cleared on chain yet)" : recomputed.matches ? " — matches the on-chain result." : " — does not match the on-chain result."}
            </span>
          )}
        </p>
      </Section>
      <Section title="Result">
        {result ? (
          <>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-3 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Clearing price P*" value={formatUsdc(result.price, 4)} unit="USDC" />
              <Stat label="Volume bought" value={formatAmount(result.volume, cls.decimals)} hint={unitLabel} />
              <Stat label="Notional" value={formatUsdc(result.notional)} unit="USDC" />
              <Stat label="Fee (30 bps)" value={formatUsdc(result.fee)} unit="USDC" />
              <Stat label="Issuer charged" value={formatUsdc(result.issuerCharged)} unit="USDC" />
              <Stat label="Issuer refund" value={formatUsdc(result.issuerRefund)} unit="USDC" />
            </dl>
            <Table>
              <THead>
                <TR>
                  <TH>#</TH>
                  <TH>Seller</TH>
                  <TH numeric>Filled</TH>
                  <TH numeric>Proceeds</TH>
                  <TH>Settled</TH>
                </TR>
              </THead>
              <TBody>
                {result.fills.map((fill) => (
                  <TR key={fill.bidId}>
                    <TD className="tabular">{fill.bidId}</TD>
                    <TD>{fill.bidder}</TD>
                    <TD numeric>{formatAmount(fill.fillQuantity, cls.decimals)}</TD>
                    <TD numeric>{formatUsdc(fill.cash)}</TD>
                    <TD>{fill.void ? <Badge tone="danger">void: {fill.void}</Badge> : <Badge tone={fill.settled ? "success" : "neutral"}>{fill.settled ? "settled" : "pending"}</Badge>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </>
        ) : (
          <p className="text-[13px] text-ink-400">{round.status === "Cancelled" ? `The round was cancelled (${round.cancelReason ?? "no reason"}): every escrow, bond and locked unit is refundable.` : "Not cleared yet."}</p>
        )}
      </Section>
      <Section title="On-chain events of this round">
        {data.events.length === 0 ? (
          <p className="text-[13px] text-ink-400">No event of this round is left in the engine&apos;s bounded history.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Seq</TH>
                <TH>Event</TH>
                <TH>When (UTC)</TH>
                <TH>By</TH>
              </TR>
            </THead>
            <TBody>
              {data.events.map((entry) => (
                <TR key={entry.seq.toString()}>
                  <TD className="tabular">{entry.seq.toString()}</TD>
                  <TD>{entry.event.event.replace(/_/g, " ")}</TD>
                  <TD>{formatDate(nsToMs(entry.timestamp))}</TD>
                  <TD>
                    <a href={nearAccountUrl(entry.predecessor)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                      {entry.predecessor}
                    </a>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {!printable ? (
          <p className="text-[12px] text-ink-400">
            Settlement and payout transactions are listed on the{" "}
            <Link href={`${ROUTES.rounds}/${round.roundId.toString()}`} className="underline-offset-2 hover:underline">
              round detail page
            </Link>
            , with the Verify panel that recomputes the same clearing.
          </p>
        ) : null}
      </Section>
      <p className="text-[11px] text-ink-400">
        Generated {formatDate(data.generatedAt)} from {data.engine} (NEAR testnet). Every number above is read from the contract; the candidate table is recomputed with the open-source clearing reference.
      </p>
    </div>
  );
}

/** `/app/issuer/results/[id]` (and its `/report` print view): the exportable Tender report. */
export function TenderResults({ roundId, printable }: { roundId: string; printable: boolean }) {
  const id = /^\d+$/.test(roundId) ? BigInt(roundId) : null;
  const fetcher = useCallback(
    (signal: AbortSignal) => {
      if (id === null) return Promise.reject(new Error(`"${roundId}" is not a round id.`));
      return fetchReport(id, signal);
    },
    [id, roundId],
  );
  const [final, setFinal] = useState(false);
  const { state, refresh } = useEngineQuery(fetcher, { pollMs: final ? FINAL_POLL_MS : printable ? 120_000 : 20_000 });
  /* A settled or cancelled round whose every order is settled no longer changes: poll rarely. */
  const nowFinal = state.status === "ok" && isFinalRound(state.value.round);
  if (nowFinal !== final) setFinal(nowFinal);
  const [printed, setPrinted] = useState(false);

  const header = (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="font-display text-[11px] uppercase tracking-wide text-ember-400">Tender report</p>
        <h1 className="font-display text-[22px] text-ink-50">Round #{roundId}</h1>
        {state.status === "ok" ? (
          <p className="mt-1 text-[13px] text-ink-400">
            {state.value.symbol} · {state.value.cls.chain} · {venueLabel(state.value.round.venue, state.value.symbols)} · {state.value.round.status}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2 print:hidden">
        {state.status === "ok" ? (
          <>
            <Button variant="secondary" onClick={() => downloadFile(`rose-tender-${roundId}.csv`, tenderReportCsv(state.value), "text/csv")} data-download-csv>
              Download CSV
            </Button>
            {printable ? (
              <Button
                onClick={() => {
                  setPrinted(true);
                  window.print();
                }}
                data-print
              >
                {printed ? "Print again" : "Print"}
              </Button>
            ) : (
              <Link href={`${ROUTES.issuer}/results/${roundId}/report`} className="inline-flex h-9 items-center rounded-md bg-ember-500 px-3.5 text-[13px] font-medium text-ink-950 hover:bg-ember-400" data-open-printable>
                Printable page
              </Link>
            )}
          </>
        ) : null}
        {!printable ? (
          <Link href={`${ROUTES.issuer}#results`} className="inline-flex h-9 items-center rounded-md border border-ink-600 bg-ink-850 px-3.5 text-[13px] text-ink-100 hover:border-ink-500">
            Back to the console
          </Link>
        ) : null}
      </div>
    </header>
  );

  return (
    <div className={printable ? "flex flex-col gap-6 print:text-black" : "flex flex-col gap-6"} data-print-root={printable ? "" : undefined}>
      {printable ? (
        <style>{`@media print { header[class*="sticky"], footer, [data-testnet-banner], nav, .print\\:hidden { display: none !important; } body, html { background: #fff !important; color: #000 !important; } [data-print-root], [data-print-root] * { color: #000 !important; border-color: #ccc !important; background: transparent !important; box-shadow: none !important; } }`}</style>
      ) : null}
      {header}
      {state.status === "loading" ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : state.status === "not_deployed" ? (
        <EmptyState illustration="vault" title="Engine not deployed yet" description="Tender reports read the round, its opened asks and its result from the engine." />
      ) : state.status === "error" ? (
        <EmptyState illustration="ember" title="Could not build the report" description={state.message} action={<Button variant="secondary" onClick={() => void refresh()}>Retry</Button>} />
      ) : (
        <Card className={printable ? "print:border-0" : undefined}>
          <CardHeader title="Report" description="Parameters, the sealed book, every opened ask, the candidate price table, the result, fills, fee and refund, and the on-chain events." />
          <CardBody>
            <ReportBody data={state.value} printable={printable} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export type { ClassInfo, RoundResult };
