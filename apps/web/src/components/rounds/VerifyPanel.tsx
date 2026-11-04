"use client";

/**
 * "Verify" (spec 8.3): recomputes the clearing price in the browser from the opened orders with
 * the `@rose/sdk` clearing reference and shows match or mismatch against the on-chain result.
 */

import { useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatQty, formatUsdc } from "./model";
import type { RoundDetail } from "./useRoundDetail";
import { verifyRound, type Verification } from "./verify";

const STATUS_COPY: Record<Verification["status"], { label: string; tone: string }> = {
  pending: { label: "Not cleared yet", tone: "text-ink-400" },
  incomplete: { label: "Book incomplete", tone: "text-warning-400" },
  match: { label: "Match", tone: "text-success-400" },
  mismatch: { label: "Mismatch", tone: "text-danger-400" },
  unsupported: { label: "Reference refused the book", tone: "text-danger-400" },
};

export function VerifyPanel({ detail }: { detail: RoundDetail }) {
  const { round, bids, cls } = detail;
  const [ran, setRan] = useState(false);
  const verification = useMemo(() => (ran ? verifyRound(round, cls.decimals, bids) : null), [bids, cls.decimals, ran, round]);
  const cleared = round.status === "Settled" || (round.status === "Cancelled" && round.cancelReason === "NoCrossing");
  /** Cancelled before any opening (no key, no orders, withdrawn): there is no book to recompute. */
  const neverOpened = round.status === "Cancelled" && round.cancelReason !== "NoCrossing";
  const copy = verification ? STATUS_COPY[verification.status] : null;
  if (neverOpened) {
    return (
      <section aria-label="Verify" className="rounded-lg border border-ink-750 bg-ink-850 px-4 py-3" data-verify="cancelled">
        <h3 className="font-display text-[13px] uppercase tracking-wide text-ink-100">Verify</h3>
        <p className="mt-0.5 text-[12px] text-ink-400">Nothing to verify: the round was cancelled before any order was opened, so no clearing price exists. Every order settles as a refund.</p>
      </section>
    );
  }

  return (
    <section aria-label="Verify" className="rounded-lg border border-ink-750 bg-ink-850" data-verify>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-750 px-4 py-3">
        <div>
          <h3 className="font-display text-[13px] uppercase tracking-wide text-ink-100">Verify</h3>
          <p className="mt-0.5 text-[12px] text-ink-400">Recompute the clearing price and every fill in this browser from the public book, with the same integer rules the contract runs.</p>
        </div>
        <Button size="sm" variant={ran ? "secondary" : "primary"} onClick={() => setRan(true)} disabled={!cleared} data-verify-run>
          {ran ? "Recompute" : "Recompute in the browser"}
        </Button>
      </div>
      <div className="px-4 py-3 text-[12px]">
        {!cleared ? (
          <p className="text-ink-400">Available once the round is cleared: the panel compares the browser&apos;s result with the one stored on chain.</p>
        ) : !verification ? (
          <p className="text-ink-400">
            {String(bids.filter((b) => b.opened !== null).length)} opened orders are public. Run the reference to compare its price, volume and fills with the contract&apos;s.
          </p>
        ) : (
          <div className="flex flex-col gap-3" data-verify-status={verification.status}>
            <p className={cn("font-display text-[14px]", copy?.tone)}>
              {copy?.label}
              {verification.status === "match" ? " · the browser reproduces the on-chain result exactly" : ""}
            </p>
            {verification.reason ? <p className="text-ink-400">{verification.reason}</p> : null}
            {verification.local && verification.onChain ? (
              <dl className="grid grid-cols-3 gap-2 rounded-md border border-ink-750 bg-ink-900 p-3">
                <div>
                  <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">Field</dt>
                  <dd className="text-ink-300">Clearing price</dd>
                  <dd className="text-ink-300">Volume</dd>
                  <dd className="text-ink-300">Fills</dd>
                </div>
                <div>
                  <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">Browser</dt>
                  <dd className="tabular text-ink-50">{verification.local.price !== null ? formatUsdc(verification.local.price) : "no crossing"}</dd>
                  <dd className="tabular text-ink-50">{verification.local.volume !== null ? formatQty(verification.local.volume, cls.decimals) : "—"}</dd>
                  <dd className="tabular text-ink-50">{String(verification.local.fills.filter((f) => f.qty > 0n).length)}</dd>
                </div>
                <div>
                  <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">On chain</dt>
                  <dd className="tabular text-ink-50">{verification.onChain.price !== null ? formatUsdc(verification.onChain.price) : "no crossing"}</dd>
                  <dd className="tabular text-ink-50">{verification.onChain.volume !== null ? formatQty(verification.onChain.volume, cls.decimals) : "—"}</dd>
                  <dd className="tabular text-ink-50">{String(verification.onChain.fills.length)}</dd>
                </div>
              </dl>
            ) : null}
            {verification.differences.length > 0 ? (
              <ul className="list-disc pl-5 text-danger-400">
                {verification.differences.map((difference) => (
                  <li key={difference}>{difference}</li>
                ))}
              </ul>
            ) : null}
            {verification.book.excluded.length > 0 ? (
              <p className="text-ink-400">
                Left out of the book: {verification.book.excluded.map((e) => `#${String(e.bidId)} (${e.reason})`).join(", ")}.
              </p>
            ) : null}
          </div>
        )}
        <div className="mt-3">
          <LearnMore topic="clearing" label="Clearing rules and worked examples" />
        </div>
      </div>
    </section>
  );
}
