"use client";

/**
 * The sealed book (spec 5.3): the number of sealed orders, each order's public collateral
 * (cash escrowed by buyers, units locked by sellers), its bond and the hash of its ciphertext.
 * Nothing else is public before the key is released; once orders are opened, their quantity
 * and price appear in the same rows.
 */

import type { Bid } from "@rose/sdk";
import { useEffect, useState } from "react";
import { CardTitle } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { ScrambleText } from "@/components/ui/ScrambleText";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Term } from "@/components/ui/Term";
import { nearAccountUrl } from "@/lib/explorer";
import { ciphertextHash } from "./ibe";
import { formatQty, formatUsdc, shortAccount } from "./model";
import type { RoundDetail } from "./useRoundDetail";

function useHashes(bids: readonly Bid[]): Map<number, string> {
  const [hashes, setHashes] = useState<Map<number, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    const missing = bids.filter((bid) => bid.ciphertextHex && !hashes.has(bid.bidId));
    if (missing.length === 0) return;
    void Promise.all(missing.map(async (bid) => [bid.bidId, await ciphertextHash(bid.ciphertextHex ?? "")] as const)).then((entries) => {
      if (!cancelled) setHashes((current) => new Map([...current, ...entries]));
    });
    return () => {
      cancelled = true;
    };
  }, [bids, hashes]);
  return hashes;
}

const VOID_LABEL: Record<string, string> = {
  Unopened: "never opened",
  EscrowTooSmall: "escrow below limit × quantity + fee",
  QuantityAboveSupply: "quantity above supply",
  QuantityAboveLocked: "quantity above locked units",
  ClaimMismatch: "quantity differs from the claim",
};

export function SealedBook({ detail }: { detail: RoundDetail }) {
  const { bids, cls, viewer, round } = detail;
  const hashes = useHashes(bids);
  const buys = bids.filter((bid) => bid.side === "Buy");
  const sells = bids.filter((bid) => bid.side === "Sell");
  const escrowed = buys.reduce((sum, bid) => sum + bid.escrow, 0n);
  const locked = sells.reduce((sum, bid) => sum + bid.lockedUnits, 0n);
  const bonds = bids.reduce((sum, bid) => sum + bid.bond, 0n);
  const opened = bids.filter((bid) => bid.opened !== null).length;
  /** An Advance reserve locks no units: its public collateral is the claim K it offers. */
  const collateralOf = (bid: Bid): string => {
    if (bid.side === "Buy") return `${formatUsdc(bid.escrow)} USDC`;
    if (round.kind === "Advance") return `claim ${formatQty(round.advanceClaim ?? 0n, cls.decimals)} tokens`;
    return `${formatQty(bid.lockedUnits, cls.decimals)} units`;
  };

  return (
    <section aria-label="Sealed book" className="ui-surface rounded-lg" data-sealed-book>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-750 px-4 py-3">
        <div>
          <CardTitle>{opened > 0 ? "Book" : <Term term="sealedBook" align="start" />}</CardTitle>
          <p className="mt-1 text-[12px] leading-snug text-ink-400">
            {opened > 0
              ? `${String(opened)} of ${String(bids.length)} orders opened; prices and quantities below are public. A ciphertext is deleted once its order settles.`
              : "Public: order count, each order's collateral and bond, ciphertext hashes. Hidden: every price and exact quantity."}
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-x-5 text-right">
          <div>
            <dt className="text-[11px] text-ink-400 font-medium">Orders</dt>
            <dd className="tabular text-[15px] text-ink-50">
              {String(bids.length)}
              <span className="text-[11px] text-ink-400">
                {" "}
                · {String(buys.length)} {buys.length === 1 ? "bid" : "bids"}, {String(sells.length)} {sells.length === 1 ? "ask" : "asks"}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-ink-400 font-medium">
              <Term term="escrow" align="end">Escrowed</Term>
            </dt>
            <dd className="tabular text-[15px] text-ink-50">{formatUsdc(escrowed)}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-ink-400 font-medium">Locked</dt>
            <dd className="tabular text-[15px] text-ink-50">{formatQty(locked, cls.decimals)}</dd>
          </div>
        </dl>
      </div>
      {bids.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-400">
          {round.status === "Open" ? "No sealed order yet. The first order sets the book in motion; the creator can withdraw the round until then." : "No order was placed in this round."}
        </p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>#</TH>
              <TH>Side</TH>
              <TH>Account</TH>
              <TH numeric>Collateral</TH>
              <TH numeric>Bond</TH>
              <TH>Ciphertext</TH>
              <TH numeric>Opened</TH>
            </TR>
          </THead>
          <TBody>
            {bids.map((bid) => {
              const mine = viewer?.account === bid.bidder;
              return (
                <TR key={bid.bidId} data-bid-row={bid.bidId} className={mine ? "bg-ember-700/10" : undefined}>
                  <TD className="tabular">{String(bid.bidId)}</TD>
                  <TD>
                    <span className={bid.side === "Buy" ? "text-success-400" : "text-rose-300"}>{bid.side === "Buy" ? "Bid" : "Ask"}</span>
                  </TD>
                  <TD>
                    <a href={nearAccountUrl(bid.bidder)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline" title={bid.bidder}>
                      {shortAccount(bid.bidder)}
                    </a>
                    {mine ? <span className="ml-1.5 text-[11px] text-ember-300 font-medium">you</span> : null}
                  </TD>
                  <TD numeric>{collateralOf(bid)}</TD>
                  <TD numeric>{formatUsdc(bid.bond)}</TD>
                  <TD>
                    {hashes.has(bid.bidId) ? (
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-400" title={hashes.get(bid.bidId)}>
                        <ScrambleText text={hashes.get(bid.bidId)!.slice(0, 16)} />
                        <CopyButton value={hashes.get(bid.bidId)!} label={`Copy the ciphertext hash of order ${String(bid.bidId)}`} />
                      </span>
                    ) : (
                      <span className="font-mono text-[11px] text-ink-400" title={bid.ciphertextHex ? undefined : "The engine deletes a ciphertext once its order settles (storage refund)."}>
                        {bid.ciphertextHex ? "hashing…" : bid.status === "Settled" ? "pruned at settlement" : "—"}
                      </span>
                    )}
                  </TD>
                  <TD numeric>
                    {bid.opened ? (
                      <span className="tabular">
                        {formatQty(bid.opened.quantity, cls.decimals)} @ {formatUsdc(bid.opened.price)}
                        {bid.void ? <span className="block text-[11px] text-danger-400">void: {VOID_LABEL[bid.void] ?? bid.void}</span> : null}
                      </span>
                    ) : bid.void ? (
                      <span className="text-[11px] text-danger-400">void: {VOID_LABEL[bid.void] ?? bid.void}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-ink-400">
                        <svg viewBox="0 0 6 7" width="8" height="9" shapeRendering="crispEdges" aria-hidden>
                          <path d="M1 0h4v1H1zM0 1h1v2H0zM5 1h1v2H5zM0 3h6v4H0z" fill="currentColor" />
                        </svg>
                        sealed
                      </span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      {bonds > 0n ? <p className="border-t border-ink-750 px-4 py-2 text-[11px] text-ink-400">Bonds posted: {formatUsdc(bonds)} USDC, refunded on a valid opening, slashed to the treasury otherwise.</p> : null}
    </section>
  );
}
