"use client";

/**
 * The viewer's own orders in this round: the on-chain row (collateral, bond, status, fill) next
 * to the plaintext this browser sealed (kept in `localStorage`), so a bidder sees what they bid
 * while the book is sealed. Settling an order is one idempotent call anyone can make.
 */

import type { Bid } from "@rose/sdk";
import { useMemo, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { useNearAction } from "./actions";
import { orderKey, rawSnapshot, subscribeLocal, type LocalOrder } from "./localOrders";
import { formatQty, formatUsdc } from "./model";
import { Notice } from "./shared";
import type { RoundDetail } from "./useRoundDetail";

function parseLocal(raw: string): LocalOrder | null {
  const parsed = JSON.parse(raw) as LocalOrder | null;
  return parsed && typeof parsed.ciphertextHex === "string" ? parsed : null;
}

function OutcomeLine({ bid, decimals }: { bid: Bid; decimals: number }) {
  if (bid.status === "Settled" || bid.fillQuantity > 0n || bid.cash > 0n) {
    if (bid.void) return <span className="text-danger-400">void ({bid.void}) · collateral refunded, bond slashed</span>;
    if (bid.fillQuantity === 0n) return <span className="text-ink-400">unfilled · collateral and bond refunded</span>;
    return (
      <span className="tabular text-ink-100">
        filled {formatQty(bid.fillQuantity, decimals)} · {bid.side === "Buy" ? "paid" : "received"} {formatUsdc(bid.cash)} USDC
        {bid.side === "Buy" && bid.fee > 0n ? ` + ${formatUsdc(bid.fee)} fee` : ""}
      </span>
    );
  }
  if (bid.void) return <span className="text-danger-400">void ({bid.void}) · bond slashed</span>;
  if (bid.opened) return <span className="text-ink-300">opened · awaiting clearing</span>;
  return <span className="text-ink-400">sealed</span>;
}

export function MyOrders({ detail, onChanged }: { detail: RoundDetail; onChanged: () => void }) {
  const { bids, viewer, engine, round, cls } = detail;
  const { run, status } = useNearAction();
  const account = viewer?.account ?? "";
  const rawBuy = useSyncExternalStore(subscribeLocal, () => rawSnapshot(orderKey(engine.account, round.roundId, account, "Buy")), () => "null");
  const rawSell = useSyncExternalStore(subscribeLocal, () => rawSnapshot(orderKey(engine.account, round.roundId, account, "Sell")), () => "null");
  const local = useMemo<{ Buy: LocalOrder | null; Sell: LocalOrder | null }>(() => ({ Buy: parseLocal(rawBuy), Sell: parseLocal(rawSell) }), [rawBuy, rawSell]);

  if (!viewer) return null;
  const mine = bids.filter((bid) => bid.bidder === viewer.account);
  if (mine.length === 0) return null;
  const settleable = round.status === "Settled" || round.status === "Cancelled";

  const settle = async (bid: Bid) => {
    const result = await run({
      label: `Settling order #${String(bid.bidId)}`,
      call: engine.calls.settleBid(round.roundId, bid.bidId),
      success: bid.fillQuantity > 0n ? `Order #${String(bid.bidId)} settled: ${bid.side === "Buy" ? "units credited" : "cash credited"}` : `Order #${String(bid.bidId)} settled: collateral refunded`,
      receipt: { engine: engine.account, roundId: round.roundId, kind: "settle", label: `settle_bid #${String(bid.bidId)}` },
    });
    if (result.ok) onChanged();
  };

  return (
    <section aria-label="My orders" className="rounded-lg border border-ember-700/60 bg-ink-850" data-my-orders>
      <div className="border-b border-ink-750 px-4 py-3">
        <h3 className="font-display text-[13px] uppercase tracking-wide text-ink-100">My orders</h3>
        <p className="mt-0.5 text-[12px] text-ink-400">What you sealed (kept in this browser) next to the public row on chain.</p>
      </div>
      <ul className="divide-y divide-ink-800">
        {mine.map((bid) => {
          const plain = local[bid.side];
          const matches = plain && plain.ciphertextHex === bid.ciphertextHex;
          return (
            <li key={bid.bidId} className="flex flex-col gap-2 px-4 py-3 text-[12px]" data-my-order={bid.bidId}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="tabular text-ink-100">#{String(bid.bidId)}</span> <span className={bid.side === "Buy" ? "text-success-400" : "text-rose-300"}>{bid.side === "Buy" ? "bid" : "ask"}</span>
                  <span className="text-ink-400"> · {bid.side === "Buy" ? `${formatUsdc(bid.escrow)} USDC escrowed` : `${formatQty(bid.lockedUnits, cls.decimals)} units locked`} · bond {formatUsdc(bid.bond)}</span>
                </span>
                <span className="font-display text-[10px] uppercase tracking-wide text-ink-300">{bid.status}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="tabular">
                  {matches ? (
                    <>
                      <span className="text-ink-400">sealed: </span>
                      <span className="text-ink-50">
                        {formatQty(BigInt(plain.quantity), cls.decimals)} @ {formatUsdc(BigInt(plain.limitPrice))} USDC
                      </span>
                    </>
                  ) : bid.opened ? (
                    <span className="text-ink-50">
                      {formatQty(bid.opened.quantity, cls.decimals)} @ {formatUsdc(bid.opened.price)} USDC
                    </span>
                  ) : (
                    <span className="text-ink-400">plaintext not in this browser (sealed elsewhere); it shows once the order is opened</span>
                  )}
                </span>
                <OutcomeLine bid={bid} decimals={cls.decimals} />
              </div>
              {settleable && bid.status !== "Settled" ? (
                <div>
                  <Button size="sm" variant="secondary" onClick={() => void settle(bid)} loading={status.status === "busy"} loadingLabel="Signing…" data-settle-mine={bid.bidId}>
                    {bid.fillQuantity > 0n ? "Claim" : "Settle (refund)"}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {status.status === "error" ? (
        <div className="px-4 pb-3">
          <Notice tone="danger">{status.error.message}</Notice>
        </div>
      ) : null}
    </section>
  );
}
