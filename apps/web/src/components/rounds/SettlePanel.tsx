"use client";

/**
 * "Settle" (spec 5.6): `settle_bid` is open to anyone and idempotent, so the action card settles
 * the viewer's own unsettled orders first and, once they have none left, every pending order of
 * the round, one transaction per order in sequence. Progress is per order with its explorer link,
 * a pause between two orders, and a resume from the chain's own `Settled` flags.
 */

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useConnectModal } from "@/components/wallet/ConnectModal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { cn } from "@/lib/cn";
import { toActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { addReceipt } from "./localOrders";
import { settleQueue, shortAccount, stopsRun } from "./model";
import type { RoundDetail } from "./useRoundDetail";

/** `hash` is null when someone else settled the order first. */
type Step = { status: "queued" } | { status: "sending" } | { status: "settled"; hash: string | null } | { status: "failed"; reason: string };

/** The engine's refusal of a second settlement ("Bid already settled or unknown"). */
const ALREADY_SETTLED = /already settled/i;

export function SettlePanel({ detail, onChanged }: { detail: RoundDetail; onChanged: () => void }) {
  const { round, bids, engine, viewer } = detail;
  const { sendNearCall, near, restoring } = useWallets();
  const openConnect = useConnectModal();
  const toast = useToast();
  const [steps, setSteps] = useState<Map<number, Step>>(() => new Map());
  const [running, setRunning] = useState(false);
  const [pausing, setPausing] = useState(false);
  const stopRef = useRef(false);
  /** Set synchronously: two clicks in the same frame must not settle every order twice. */
  const runningRef = useRef(false);

  /* An order this browser just settled stays out of the queue until the next read shows it settled. */
  const { scope, queue: fromChain } = settleQueue(bids, viewer?.account ?? null);
  const queue = fromChain.filter((bid) => steps.get(bid.bidId)?.status !== "settled");

  const setStep = useCallback((bidId: number, step: Step) => setSteps((current) => new Map(current).set(bidId, step)), []);

  const runAll = async () => {
    if (runningRef.current || queue.length === 0) return;
    runningRef.current = true;
    stopRef.current = false;
    setPausing(false);
    setRunning(true);
    const ids = queue.map((bid) => bid.bidId);
    setSteps((current) => {
      const next = new Map(current);
      for (const id of ids) next.set(id, { status: "queued" });
      return next;
    });
    let settled = 0;
    for (const bidId of ids) {
      if (stopRef.current) break;
      setStep(bidId, { status: "sending" });
      try {
        const outcome = await sendNearCall(engine.calls.settleBid(round.roundId, bidId));
        const hash = outcome.transaction.hash;
        addReceipt(engine.account, round.roundId, { kind: "settle", chain: "near", hash, at: Date.now(), label: `settle_bid #${String(bidId)}` });
        setStep(bidId, { status: "settled", hash });
        settled += 1;
      } catch (error) {
        const described = toActionError(error);
        if (ALREADY_SETTLED.test(described.message)) {
          setStep(bidId, { status: "settled", hash: null });
          continue;
        }
        setStep(bidId, { status: "failed", reason: described.message });
        if (stopsRun(described.kind)) {
          toast.show({ tone: "error", title: described.title, description: described.message });
          break;
        }
      }
    }
    runningRef.current = false;
    setRunning(false);
    setPausing(false);
    onChanged();
    if (settled > 0) toast.show({ tone: "success", title: `${String(settled)} ${settled === 1 ? "order" : "orders"} settled`, description: "Cash, units, refunds and bonds are in each participant's NEAR ledger." });
  };

  const count = queue.length;
  /* Until the round is read with the connected account, the scope ("my order" or "every order") is not known yet. */
  const readingViewer = near.status === "connected" && viewer?.account !== near.accountId;
  const label = scope === "mine" ? `Settle my ${count === 1 ? "order" : `${String(count)} orders`}` : `Settle every order · ${String(count)} left`;
  const listed = bids.filter((bid) => steps.has(bid.bidId));

  return (
    <div className="flex flex-col gap-2" data-settle-panel={scope}>
      {!restoring && near.status !== "connected" ? (
        <Button size="lg" className="w-full" onClick={() => openConnect("near")} data-connect-prompt="near">
          Connect a NEAR wallet to settle
        </Button>
      ) : (
        <Button size="lg" className="w-full" onClick={() => void runAll()} loading={running || readingViewer} loadingLabel={running ? "Settling orders" : "Reading your orders"} disabled={count === 0 || near.status !== "connected"} data-action="settle">
          {count === 0 ? "Settled · updating the round" : label}
        </Button>
      )}
      {restoring ? <p className="text-[11.5px] text-ink-400">Restoring your wallet…</p> : null}
      {running ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px] text-ink-300" data-settle-pause>
          <span>{pausing ? "The run stops once the order in flight lands." : "Each order is one NEAR transaction; you can stop between two of them."}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={pausing}
            onClick={() => {
              stopRef.current = true;
              setPausing(true);
            }}
          >
            {pausing ? "Pausing…" : "Pause after this order"}
          </Button>
        </div>
      ) : null}
      {listed.length > 0 ? (
        <ol className="flex flex-col divide-y divide-ink-800 text-[12px]" aria-label="Settlement progress">
          {listed.map((bid) => {
            const step = steps.get(bid.bidId) ?? { status: "queued" as const };
            return (
              <li key={bid.bidId} className="flex items-center justify-between gap-3 py-2" data-settle-step={bid.bidId} data-settle-status={step.status}>
                <div className="min-w-0">
                  <span className="tabular text-ink-100">#{String(bid.bidId)}</span>
                  <span className="text-ink-400">
                    {" "}
                    {bid.side === "Buy" ? "bid" : "ask"} by {viewer?.account === bid.bidder ? "you" : shortAccount(bid.bidder)}
                  </span>
                  {step.status === "failed" ? <p className="mt-0.5 text-[11px] text-danger-400">{step.reason}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {step.status === "settled" && step.hash !== null ? (
                    <a href={txLinks("near", step.hash)[0]?.href} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-ember-300 underline-offset-2 hover:underline">
                      tx ↗
                    </a>
                  ) : null}
                  <span
                    className={cn(
                      "text-[11px] font-medium",
                      step.status === "settled" && "text-success-400",
                      step.status === "failed" && "text-danger-400",
                      step.status === "sending" && "text-ember-300",
                      step.status === "queued" && "text-ink-400",
                    )}
                  >
                    {step.status === "settled" && step.hash === null ? "already settled" : step.status}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
