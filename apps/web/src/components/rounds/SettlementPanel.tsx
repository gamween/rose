"use client";

/**
 * Settlement and payout links (spec 8.3): the transactions this browser sent for the round
 * (close, openings, clear, settlements, cash deposits) with explorer links, and where the
 * proceeds go next on NEAR, Base and Solana. The engine keeps no transaction hashes (no
 * indexer), so links to other participants' transactions go through the engine account page.
 */

import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import { addressUrl, nearAccountUrl, txUrl } from "@/lib/explorer";
import { deployed } from "@/lib/deployment";
import { ROUTES } from "@/lib/routes";
import { rawSnapshot, receiptsKey, subscribeLocal, type Receipt } from "./localOrders";
import { formatDateTime, venueChain, venueLabel, venueTokenAccount } from "./model";
import type { RoundDetail } from "./useRoundDetail";

export function SettlementPanel({ detail }: { detail: RoundDetail }) {
  const { round, engine, cls } = detail;
  const key = receiptsKey(engine.account, round.roundId);
  const raw = useSyncExternalStore(subscribeLocal, () => rawSnapshot(key), () => "null");
  const receipts = useMemo(() => {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Receipt[]) : [];
  }, [raw]);

  const roseVault = deployed("roseVault");
  const solanaVault = deployed("solanaVault");
  const settledOrCancelled = round.status === "Settled" || round.status === "Cancelled";

  return (
    <section aria-label="Settlement and payouts" className="rounded-lg border border-ink-750 bg-ink-850" data-settlement>
      <div className="border-b border-ink-750 px-4 py-3">
        <h3 className="font-display text-[13px] uppercase tracking-wide text-ink-100">Settlement and payouts</h3>
        <p className="mt-0.5 text-[12px] text-ink-400">Cash and units settle inside the NEAR ledger; tokens are pulled to Base or Solana from the Portfolio.</p>
      </div>
      <dl className="grid gap-3 px-4 py-3 text-[12px] sm:grid-cols-3">
        <div>
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">NEAR · cash and units</dt>
          <dd className="mt-0.5 flex flex-col gap-0.5">
            <a href={nearAccountUrl(engine.account)} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">
              engine {engine.account} ↗
            </a>
            <a href={nearAccountUrl(venueTokenAccount(round.venue))} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">
              {round.venue === "Near" ? `cash token ${venueTokenAccount(round.venue)}` : `venue ${venueLabel(round.venue)}`} ↗
            </a>
            <Link href={ROUTES.portfolio} className="text-ember-300 underline-offset-2 hover:underline">
              Claim cash and units in the Portfolio →
            </Link>
          </dd>
        </div>
        <div>
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">Base Sepolia · {cls.chain === "Base" ? "stream tokens" : "cash"}</dt>
          <dd className="mt-0.5 flex flex-col gap-0.5">
            {roseVault ? (
              <a href={addressUrl("base", roseVault)} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">
                RoseVault {roseVault.slice(0, 10)}… ↗
              </a>
            ) : (
              <span className="text-ink-400">RoseVault not deployed yet</span>
            )}
            {round.venue !== "Near" ? (
              <a href={addressUrl("base", round.venue.Base.token)} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">
                cash token {round.venue.Base.token.slice(0, 10)}… ↗
              </a>
            ) : null}
            {cls.chain === "Base" ? (
              <a href={addressUrl("base", cls.token)} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">
                class token {cls.token.slice(0, 10)}… ↗
              </a>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">Solana devnet · {cls.chain === "Solana" ? "stream tokens" : "no leg"}</dt>
          <dd className="mt-0.5 flex flex-col gap-0.5">
            {cls.chain === "Solana" ? (
              <>
                {solanaVault ? (
                  <a href={addressUrl("solana", solanaVault)} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">
                    vault {solanaVault.slice(0, 10)}… ↗
                  </a>
                ) : (
                  <span className="text-ink-400">Solana vault not bootstrapped yet</span>
                )}
                <a href={addressUrl("solana", cls.token)} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">
                  mint {cls.token.slice(0, 10)}… ↗
                </a>
              </>
            ) : (
              <span className="text-ink-400">This class lives on Base; nothing moves on Solana.</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="border-t border-ink-750 px-4 py-3">
        <h4 className="font-display text-[10px] uppercase tracking-wide text-ink-400">Transactions sent from this browser</h4>
        {receipts.length === 0 ? (
          <p className="mt-1 text-[12px] text-ink-400">{settledOrCancelled ? "None yet. Every transaction you send for this round is listed here with its explorer link." : "Actions you take on this round appear here with their explorer links."}</p>
        ) : (
          <ol className="mt-1 flex flex-col divide-y divide-ink-800 text-[12px]" data-receipts>
            {[...receipts].reverse().map((receipt) => (
              <li key={receipt.hash} className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate">
                  <span className="font-display text-[10px] uppercase tracking-wide text-ink-300">{receipt.kind}</span> <span className="text-ink-400">{receipt.label}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="tabular text-[11px] text-ink-400">{formatDateTime(receipt.at).replace(" UTC", "")}</span>
                  <a href={txUrl(receipt.chain, receipt.hash)} target="_blank" rel="noreferrer" className="tabular text-ember-300 underline-offset-2 hover:underline">
                    {receipt.hash.slice(0, 8)}… ↗
                  </a>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-[11px] text-ink-400">Chain of the venue: {venueChain(round.venue) === "near" ? "NEAR testnet" : "Base Sepolia"}.</p>
      </div>
    </section>
  );
}
