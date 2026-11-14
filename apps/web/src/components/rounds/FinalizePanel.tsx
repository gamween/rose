"use client";

/**
 * "Finalize" (spec 5.2 step 2): with the round key public, this browser decrypts every sealed
 * order that is still unopened and submits `open_bid` for each one in sequence, one transaction
 * per order prepaid with 200 Tgas. Progress is per order, failures do not stop the run (a
 * malformed ciphertext can be opened by nobody and is void at clearing), and the run resumes
 * from the chain's own `opened` flags after a reload.
 */

import type { Bid } from "@rose/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useConnectModal } from "@/components/wallet/ConnectModal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { cn } from "@/lib/cn";
import { toActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { checkRoundKey, openOrder, orderIdentity } from "./ibe";
import { addReceipt } from "./localOrders";
import { formatQty, formatUsdc, OPENING_COST_NEAR, shortAccount } from "./model";
import { Notice } from "./shared";
import type { RoundDetail } from "./useRoundDetail";

/** The engine's refusal of a second opening ("Bid already opened", whichever the side). */
const ALREADY_OPENED = /already opened/i;

type Step =
  | { status: "queued" }
  | { status: "decrypting" }
  | { status: "sending"; quantity: bigint; price: bigint }
  /** `hash` is null when another browser opened the order first (the engine refuses a second opening). */
  | { status: "opened"; quantity: bigint; price: bigint; hash: string | null }
  | { status: "unopenable"; reason: string }
  | { status: "failed"; reason: string; retryable: boolean };

/** The opening progress, rendered inside the round's action card while the round reveals and clears. */
export function FinalizePanel({ detail, onChanged }: { detail: RoundDetail; onChanged: () => void }) {
  const { round, bids, engine, config, cls } = detail;
  const { sendNearCall, near, restoring } = useWallets();
  const openConnect = useConnectModal();
  const toast = useToast();
  const [steps, setSteps] = useState<Map<number, Step>>(() => new Map());
  const [running, setRunning] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [keyState, setKeyState] = useState<"unchecked" | "valid" | "invalid" | "error">("unchecked");
  const stopRef = useRef(false);
  const latestBids = useRef<Bid[]>(bids);
  useEffect(() => {
    latestBids.current = bids;
  }, [bids]);

  /* An order this browser just opened stays out of the list of sealed ones until the next read shows it opened. */
  const sealed = useMemo(() => bids.filter((bid) => bid.opened === null && bid.status === "Sealed" && bid.ciphertextHex && steps.get(bid.bidId)?.status !== "opened"), [bids, steps]);
  const key = round.key;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    checkRoundKey(config.ckd_public_key, engine.account, round.roundId, key)
      .then((valid) => {
        if (!cancelled) setKeyState(valid ? "valid" : "invalid");
      })
      .catch(() => {
        if (!cancelled) setKeyState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [config.ckd_public_key, engine.account, key, round.roundId]);

  const setStep = useCallback((bidId: number, step: Step) => setSteps((current) => new Map(current).set(bidId, step)), []);
  const latestSteps = useRef(steps);
  useEffect(() => {
    latestSteps.current = steps;
  }, [steps]);

  /** Set synchronously: two clicks in the same frame both see `running === false`, and must not open every order twice. */
  const runningRef = useRef(false);

  const runAll = useCallback(async () => {
    if (!key || running || runningRef.current) return;
    runningRef.current = true;
    stopRef.current = false;
    setPausing(false);
    setRunning(true);
    const done = latestSteps.current;
    const queue = latestBids.current.filter((bid) => bid.opened === null && bid.status === "Sealed" && bid.ciphertextHex && done.get(bid.bidId)?.status !== "opened");
    setSteps((current) => {
      const next = new Map(current);
      for (const bid of queue) next.set(bid.bidId, { status: "queued" });
      return next;
    });
    let opened = 0;
    for (const bid of queue) {
      if (stopRef.current) break;
      setStep(bid.bidId, { status: "decrypting" });
      let plaintextHex: string;
      let sigma: string;
      let quantity: bigint;
      let price: bigint;
      try {
        const result = await openOrder(orderIdentity(config.ckd_public_key, engine.account, round.roundId, bid.bidder, bid.side), key, bid.ciphertextHex ?? "");
        plaintextHex = result.plaintextHex;
        sigma = result.sigma;
        quantity = result.quantity;
        price = result.limitPrice;
      } catch {
        setStep(bid.bidId, { status: "unopenable", reason: "The ciphertext does not decrypt under the round key: nobody can open it (its author included). It is void at clearing and its bond is slashed." });
        continue;
      }
      setStep(bid.bidId, { status: "sending", quantity, price });
      try {
        const outcome = await sendNearCall(engine.calls.openBid(round.roundId, bid.bidId, plaintextHex, sigma));
        const hash = outcome.transaction.hash;
        addReceipt(engine.account, round.roundId, { kind: "open", chain: "near", hash, at: Date.now(), label: `open_bid #${String(bid.bidId)}` });
        setStep(bid.bidId, { status: "opened", quantity, price, hash });
        opened += 1;
      } catch (error) {
        const described = toActionError(error);
        if (ALREADY_OPENED.test(described.message)) {
          setStep(bid.bidId, { status: "opened", quantity, price, hash: null });
          continue;
        }
        setStep(bid.bidId, { status: "failed", reason: described.message, retryable: described.retryable || described.kind === "contract" });
        if (described.kind === "rejected" || described.kind === "no_wallet" || described.kind === "insufficient_balance") {
          toast.show({ tone: "error", title: described.title, description: described.message });
          break;
        }
      }
    }
    runningRef.current = false;
    setRunning(false);
    setPausing(false);
    onChanged();
    if (opened > 0) toast.show({ tone: "success", title: `${String(opened)} ${opened === 1 ? "order" : "orders"} opened on chain`, description: "The book is public; the Verify panel can recompute the result once the window ends." });
  }, [config.ckd_public_key, engine, key, onChanged, round.roundId, running, sendNearCall, setStep, toast]);

  const unfinished = [...steps.values()].some((step) => step.status === "queued" || step.status === "failed");

  if (!key || (round.status !== "Revealing" && round.status !== "Clearing")) return null;

  const windowOpen = round.status === "Revealing";
  const remaining = sealed.length;
  const done = round.openedCount;
  const total = round.bidCount;
  const cost = (remaining * Number(OPENING_COST_NEAR)).toFixed(4);

  return (
    <section aria-label="Opening progress" className="mt-4 border-t border-ink-750 pt-3" data-finalize>
      <div className="flex flex-col gap-2">
        <div>
          <h3 className="text-[12px] font-medium text-ink-200">Opening progress</h3>
          <p className="mt-0.5 text-[12px] text-ink-400">
            <span className="tabular text-ink-100">
              {String(done)} / {String(total)}
            </span>{" "}
            opened on chain ·{" "}
            {!windowOpen
              ? remaining > 0
                ? `the reveal window closed with ${String(remaining)} unopened: void at clearing, bond slashed`
                : "the reveal window closed; clearing can run"
              : remaining > 0
                ? `${String(remaining)} left, about ${cost} NEAR of gas in total (${OPENING_COST_NEAR} per order, 200 Tgas prepaid each)`
                : "nothing left to open"}
          </p>
        </div>
        {/* The run button keeps its place and turns into a disabled progress label while the run
            goes, so a second click lands on nothing; pausing is a separate control under the
            progress bar. */}
        {!restoring && near.status !== "connected" && windowOpen && remaining > 0 ? (
          <Button className="w-full" onClick={() => openConnect("near")} data-connect-prompt="near">
            Connect a NEAR wallet to open every order
          </Button>
        ) : remaining > 0 || running ? (
          <Button className="w-full" onClick={() => void runAll()} loading={running} loadingLabel="Opening orders" disabled={!windowOpen || remaining === 0 || keyState !== "valid" || near.status !== "connected"} data-finalize-run>
            {unfinished ? "Resume" : "Open every order"}
          </Button>
        ) : null}
      </div>
      <div className="pt-3">
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-sm bg-ink-800" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Orders opened">
          <div className="h-full bg-ember-500 transition-[width] duration-500" style={{ width: `${String(total === 0 ? 0 : Math.round((done / total) * 100))}%` }} />
        </div>
        {running ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px] text-ink-300" data-finalize-pause>
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
        {keyState === "invalid" ? <Notice tone="danger">The stored key does not verify against the CKD public key in this browser. Do not open anything; this should be impossible since the contract verified it with a pairing check.</Notice> : null}
        {keyState === "error" ? <Notice tone="warning">The IBE module could not load in this browser, so orders cannot be decrypted here. Reload the page or use another browser.</Notice> : null}
        {keyState === "valid" ? <p className="mb-2 text-[11px] text-success-400">Round key verified in the browser against the CKD public key.</p> : null}
        {restoring ? <Notice tone="info">Restoring your wallet…</Notice> : null}
        {remaining === 0 && steps.size === 0 ? (
          <p className="text-[12px] text-ink-400">{windowOpen ? "Every order is open. Clearing runs after the reveal window." : "Every order was opened; clear the round."}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-ink-800 text-[12px]">
            {sealed.concat(bids.filter((bid) => steps.has(bid.bidId) && !sealed.includes(bid))).map((bid) => {
              const step = steps.get(bid.bidId) ?? { status: "queued" as const };
              return (
                <li key={bid.bidId} className="flex items-center justify-between gap-3 py-2" data-open-step={bid.bidId} data-open-status={step.status}>
                  <div className="min-w-0">
                    <span className="tabular text-ink-100">#{String(bid.bidId)}</span>
                    <span className="text-ink-400">
                      {" "}
                      {bid.side === "Buy" ? "bid" : "ask"} by {shortAccount(bid.bidder)}
                    </span>
                    {step.status === "sending" || step.status === "opened" ? (
                      <span className="tabular text-ink-300">
                        {" "}
                        · {formatQty(step.quantity, cls.decimals)} @ {formatUsdc(step.price)}
                      </span>
                    ) : null}
                    {step.status === "unopenable" || step.status === "failed" ? <p className="mt-0.5 text-[11px] text-danger-400">{step.reason}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {step.status === "opened" && step.hash !== null ? (
                      <a href={txLinks("near", step.hash)[0]?.href} target="_blank" rel="noreferrer" className="text-[11px] text-ember-300 underline-offset-2 hover:underline font-medium">
                        tx ↗
                      </a>
                    ) : null}
                    <span
                      className={cn(
                        "text-[11px] font-medium",
                        step.status === "opened" && "text-success-400",
                        step.status === "failed" && "text-danger-400",
                        step.status === "unopenable" && "text-danger-400",
                        (step.status === "decrypting" || step.status === "sending") && "text-ember-300",
                        step.status === "queued" && "text-ink-400",
                      )}
                    >
                      {step.status === "opened" && step.hash === null ? "already opened" : step.status}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
