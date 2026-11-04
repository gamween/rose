"use client";

/**
 * Fills after clearing (spec 8.3): one row per order with its opened values, fill, cash and
 * settlement state, plus the issuer line of a Tender. "Settle" is per order and open to anyone.
 */

import type { BidOutcome, Round } from "@rose/sdk";
import { Button } from "@/components/ui/Button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { nearAccountUrl } from "@/lib/explorer";
import { useNearAction } from "./actions";
import { cancelledOutcome, clearingOf, formatQty, formatUsdc, shortAccount } from "./model";
import { Notice } from "./shared";
import type { RoundDetail } from "./useRoundDetail";

function orderBy(round: Round, fills: readonly BidOutcome[]): BidOutcome[] {
  return [...fills].sort((a, b) => {
    if (a.side !== b.side) return a.side === "Buy" ? -1 : 1;
    const pa = a.opened?.price ?? 0n;
    const pb = b.opened?.price ?? 0n;
    if (pa !== pb) return a.side === "Buy" ? (pa > pb ? -1 : 1) : pa < pb ? -1 : 1;
    return a.bidId - b.bidId;
  }).filter(() => round.result !== null);
}

export function FillsTable({ detail, onChanged }: { detail: RoundDetail; onChanged: () => void }) {
  const { round, cls, engine, viewer } = detail;
  const { run, status } = useNearAction();
  if (!round.result) return null;
  const result = round.result;
  const cleared = clearingOf(round);
  const fills = orderBy(round, result.fills);
  const pending = fills.filter((f) => !f.settled);

  const settleOne = async (bidId: number) => {
    const r = await run({ label: `Settling order #${String(bidId)}`, call: engine.calls.settleBid(round.roundId, bidId), success: `Order #${String(bidId)} settled`, receipt: { engine: engine.account, roundId: round.roundId, kind: "settle", label: `settle_bid #${String(bidId)}` } });
    if (r.ok) onChanged();
  };

  const settleAll = async () => {
    for (const fill of pending) {
      const r = await run({ label: `Settling order #${String(fill.bidId)} (${String(pending.indexOf(fill) + 1)}/${String(pending.length)})`, call: engine.calls.settleBid(round.roundId, fill.bidId), success: `Order #${String(fill.bidId)} settled`, receipt: { engine: engine.account, roundId: round.roundId, kind: "settle", label: `settle_bid #${String(fill.bidId)}` } });
      if (!r.ok) break;
    }
    onChanged();
  };

  return (
    <section aria-label="Fills" className="rounded-lg border border-ink-750 bg-ink-850" data-fills>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-750 px-4 py-3">
        <div>
          <h3 className="font-display text-[13px] uppercase tracking-wide text-ink-100">{cleared ? "Fills" : "Refunds"}</h3>
          {cleared ? (
            <p className="mt-0.5 text-[12px] text-ink-400" data-fills-summary="cleared">
              Cleared at <span className="tabular text-ink-100">{formatUsdc(cleared.price)} USDC</span> per {round.kind === "Advance" ? "claimed token" : "locked token"} · volume <span className="tabular text-ink-100">{formatQty(cleared.volume, cls.decimals)}</span> · notional{" "}
              <span className="tabular text-ink-100">{formatUsdc(cleared.notional)}</span> · fee <span className="tabular text-ink-100">{formatUsdc(cleared.fee)}</span> (30 bps, buying side)
            </p>
          ) : (
            <p className="mt-0.5 text-[12px] text-ink-400" data-fills-summary="cancelled">
              Cancelled ({cancelledOutcome(round).toLowerCase()}) · nothing traded: every escrow, valid bond and locked unit is refunded when its order settles.
            </p>
          )}
        </div>
        {pending.length > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => void settleAll()} loading={status.status === "busy"} loadingLabel="Signing…" disabled={!viewer} data-settle-all>
            Settle all · {String(pending.length)}
          </Button>
        ) : (
          <span className="font-display text-[10px] uppercase tracking-wide text-success-400">all settled</span>
        )}
      </div>
      {round.kind === "Tender" && cleared ? (
        <p className="border-b border-ink-750 px-4 py-2 text-[12px] text-ink-300">
          Issuer <span className="tabular">{shortAccount(round.creator)}</span>: charged <span className="tabular text-ink-100">{formatUsdc(cleared.issuerCharged)}</span> + fee {formatUsdc(cleared.fee)}, refunded{" "}
          <span className="tabular text-ink-100">{formatUsdc(cleared.issuerRefund)}</span> of the {formatUsdc(round.budget ?? 0n)} budget. Bought units are retired to {round.retireTo ?? "the issuer"}.
        </p>
      ) : null}
      <Table>
        <THead>
          <TR>
            <TH>#</TH>
            <TH>Side</TH>
            <TH>Account</TH>
            <TH numeric>Opened</TH>
            <TH numeric>Filled</TH>
            <TH numeric>Cash</TH>
            <TH numeric>Bond</TH>
            <TH numeric>State</TH>
          </TR>
        </THead>
        <TBody>
          {fills.map((fill) => {
            const mine = viewer?.account === fill.bidder;
            return (
              <TR key={fill.bidId} data-fill-row={fill.bidId} className={mine ? "bg-ember-700/10" : undefined}>
                <TD className="tabular">{String(fill.bidId)}</TD>
                <TD>
                  <span className={fill.side === "Buy" ? "text-success-400" : "text-rose-300"}>{fill.side === "Buy" ? "Bid" : "Ask"}</span>
                </TD>
                <TD>
                  <a href={nearAccountUrl(fill.bidder)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline" title={fill.bidder}>
                    {shortAccount(fill.bidder)}
                  </a>
                  {mine ? <span className="ml-1.5 font-display text-[10px] uppercase tracking-wide text-ember-300">you</span> : null}
                </TD>
                <TD numeric>
                  {fill.opened ? `${formatQty(fill.opened.quantity, cls.decimals)} @ ${formatUsdc(fill.opened.price)}` : "—"}
                  {fill.void ? <span className="block text-[11px] text-danger-400">void: {fill.void}</span> : null}
                </TD>
                <TD numeric>{fill.fillQuantity > 0n ? formatQty(fill.fillQuantity, cls.decimals) : <span className="text-ink-400">0</span>}</TD>
                <TD numeric>
                  {fill.cash > 0n ? (
                    <>
                      {fill.side === "Buy" ? "−" : "+"}
                      {formatUsdc(fill.cash)}
                      {fill.fee > 0n ? <span className="block text-[11px] text-ink-400">fee {formatUsdc(fill.fee)}</span> : null}
                    </>
                  ) : (
                    <span className="text-ink-400">refund</span>
                  )}
                </TD>
                <TD numeric>{fill.void ? <span className="text-danger-400">slashed</span> : <span className="text-ink-300">{formatUsdc(fill.bond)} back</span>}</TD>
                <TD numeric>
                  {fill.settled ? (
                    <span className="font-display text-[10px] uppercase tracking-wide text-success-400">settled</span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void settleOne(fill.bidId)} disabled={!viewer || status.status === "busy"} data-settle={fill.bidId}>
                      Settle
                    </Button>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      {status.status === "error" ? (
        <div className="px-4 pb-3 pt-2">
          <Notice tone="danger">{status.error.message}</Notice>
        </div>
      ) : null}
    </section>
  );
}
