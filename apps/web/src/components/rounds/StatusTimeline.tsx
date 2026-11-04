"use client";

/**
 * Status timeline with the NEXT ACTION button for whoever is looking (spec 5.6, 8.3): "Close
 * round" after `closes_at`, "Finalize" while revealing, "Clear" after the window, "Settle"
 * afterwards, "Cancel (no key)" when the MPC never answered, and the creator's withdrawal before
 * the first order. The key release block shows the MPC latency once the key is in.
 */

import { useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { cn } from "@/lib/cn";
import { nearAccountUrl } from "@/lib/explorer";
import { useNearAction } from "./actions";
import { canCancelAsCreator, canCancelNoKey, formatDateTime, formatDuration, NEXT_ACTION_LABEL, nextAction, nsToMs, OPENING_COST_NEAR, timeline, type NextAction } from "./model";
import { Notice } from "./shared";
import type { RoundDetail } from "./useRoundDetail";

function StepDot({ state }: { state: "done" | "active" | "upcoming" | "failed" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 flex size-3 items-center justify-center rounded-sm border",
        state === "done" && "border-success-500 bg-success-500",
        state === "active" && "border-ember-400 bg-ember-500 shadow-[0_0_0_3px_rgb(242_98_46/0.25)]",
        state === "upcoming" && "border-ink-600 bg-ink-850",
        state === "failed" && "border-danger-500 bg-danger-500",
      )}
    >
      {state === "active" ? <span className="size-1 animate-pulse bg-ink-950" /> : null}
    </span>
  );
}

function describe(action: NextAction, viewer: string | null): { title: string; body: string } {
  switch (action.kind) {
    case "wait_open":
      return { title: "Not open yet", body: `Orders are accepted from ${formatDateTime(action.at)}.` };
    case "bid":
      return { title: viewer ? "Bidding is open" : "Bidding is open", body: viewer ? "Place a sealed order below. Prices and exact quantities stay hidden until the key is released after the close." : "Connect a NEAR wallet to place a sealed order. The book stays sealed until the close." };
    case "close":
      return { title: "The round has closed", body: "Anyone can close it now: this asks the NEAR MPC network for the round's decryption key (about 5 s, 60 Tgas). Retries are free, the key is deterministic." };
    case "waiting_key":
      return { title: "Key requested from the MPC", body: `The contract is waiting for the CKD callback (measured 4 to 6 s). If nothing arrives by ${formatDateTime(action.cancelAt)}, anyone can cancel the round and every escrow becomes refundable.` };
    case "cancel_no_key":
      return { title: "No key within the timeout", body: "The MPC never delivered the key. Anyone can cancel the round: nothing was opened, every escrow, bond and locked unit becomes refundable." };
    case "finalize":
      return { title: `${String(action.remaining)} sealed ${action.remaining === 1 ? "order" : "orders"} to open`, body: `The key is public: this browser decrypts every remaining order and submits one \`open_bid\` per order (200 Tgas prepaid, about ${OPENING_COST_NEAR} NEAR of gas each). Resumable at any time.` };
    case "wait_reveal":
      return { title: "Every order is open", body: `The reveal window runs until ${formatDateTime(action.until)}; clearing can run right after.` };
    case "clear":
      return { title: "Ready to clear", body: "Anyone can compute the clearing price and every fill in one transaction (50 Tgas prepaid). Orders nobody opened are void and lose their bond." };
    case "settle":
      return { title: `${String(action.pending)} ${action.pending === 1 ? "order" : "orders"} to settle`, body: "Settlement is per order and idempotent: units, cash, refunds and bond go to each participant; the storage deposit of the order is returned." };
    case "done":
      return { title: "Every order is settled", body: "Cash and units moved inside the NEAR ledger. Payouts to Base and Solana are pulled from the Portfolio." };
  }
}

export function StatusTimeline({ detail, nowMs, onChanged, onFinalize, onSettle }: { detail: RoundDetail; nowMs: number; onChanged: () => void; onFinalize: () => void; onSettle: () => void }) {
  const { round, engine, viewer } = detail;
  const action = nextAction(round, nowMs);
  const steps = timeline(round, nowMs, detail.cls.decimals);
  const text = describe(action, viewer?.account ?? null);
  const { run, status } = useNearAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const busy = status.status === "busy";
  const connected = viewer !== null;
  const receipt = (kind: "close" | "clear" | "cancel", label: string) => ({ engine: engine.account, roundId: round.roundId, kind, label });

  const act = async () => {
    const id = round.roundId;
    let result;
    switch (action.kind) {
      case "close":
        result = await run({ label: `Closing round #${id.toString()}`, call: engine.calls.close(id), success: "Round closed, key requested from the MPC", receipt: receipt("close", "close") });
        break;
      case "cancel_no_key":
        result = await run({ label: `Cancelling round #${id.toString()} (no key)`, call: engine.calls.cancelNoKey(id), success: "Round cancelled: everything is refundable", receipt: receipt("cancel", "cancel_no_key") });
        break;
      case "clear":
        result = await run({ label: `Clearing round #${id.toString()}`, call: engine.calls.clear(id), success: "Round cleared", receipt: receipt("clear", "clear") });
        break;
      case "waiting_key":
        result = await run({ label: `Retrying the key request for #${id.toString()}`, call: engine.calls.close(id), success: "Key requested again", receipt: receipt("close", "close (retry)") });
        break;
      default:
        return;
    }
    if (result.ok) onChanged();
  };

  const cancelAsCreator = async () => {
    const result = await run({ label: `Withdrawing round #${round.roundId.toString()}`, call: engine.calls.cancelRound(round.roundId), success: "Round withdrawn", receipt: receipt("cancel", "cancel_round") });
    if (result.ok) onChanged();
  };

  const keyLatency = round.keyReceivedAt !== null && round.closeRequestedAt !== null ? Number(round.keyReceivedAt - round.closeRequestedAt) / 1e9 : null;
  const retryVisible = action.kind === "waiting_key" && nowMs - action.since > 30_000;

  return (
    <section aria-label="Status" className="rounded-lg border border-ink-750 bg-ink-850" data-timeline>
      <ol className="relative grid grid-cols-5 gap-2 border-b border-ink-750 px-4 pb-3 pt-4">
        <span aria-hidden className="absolute left-[calc(10%+2px)] right-[calc(10%+2px)] top-[21.5px] h-px bg-ink-700" />
        {steps.map((step) => (
          <li key={step.id} className="flex min-w-0 flex-col items-center gap-1.5 text-center" data-step={step.id} data-state={step.state}>
            <StepDot state={step.state} />
            <span className={cn("font-display text-[10px] uppercase tracking-wide", step.state === "active" ? "text-ember-300" : step.state === "failed" ? "text-danger-400" : step.state === "done" ? "text-ink-200" : "text-ink-500")}>{step.label}</span>
            <span className="tabular hidden text-[11px] text-ink-400 sm:block">{step.at !== null ? formatDateTime(step.at).replace(" UTC", "") : "—"}</span>
            <span className="hidden text-[11px] leading-tight text-ink-500 lg:block">{step.detail}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-3 p-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-display text-[14px] text-ink-50" data-next-action={action.kind}>
            {text.title}
          </p>
          <p className="mt-1 max-w-2xl text-[12px] text-ink-400">{text.body}</p>
          {round.key ? (
            <div className="mt-3 rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px]" data-key-release>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-display text-[10px] uppercase tracking-wide text-success-400">Key released</span>
                <span className="text-ink-300">
                  {round.keySource === "Submitted" ? "submitted by a participant" : "MPC callback"}
                  {keyLatency !== null ? <span className="tabular"> · {keyLatency.toFixed(1)} s after the close request</span> : null}
                  {round.keyReceivedAt !== null ? <span> · {formatDateTime(nsToMs(round.keyReceivedAt))}</span> : null}
                </span>
              </div>
              <p className="tabular mt-1 truncate text-ink-400" title={round.key}>
                {round.key}
              </p>
            </div>
          ) : null}
          {round.status === "KeyRequested" && action.kind === "waiting_key" ? (
            <p className="tabular mt-2 text-[12px] text-ink-300">
              waiting since {formatDateTime(action.since)} · cancel possible in <Countdown target={action.cancelAt} endedLabel="now" />
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2 md:items-end">
          {action.kind === "close" || action.kind === "cancel_no_key" || action.kind === "clear" ? (
            <Button onClick={() => void act()} loading={busy} loadingLabel="Signing…" disabled={!connected} variant={action.kind === "cancel_no_key" ? "danger" : "primary"} data-action={action.kind}>
              {NEXT_ACTION_LABEL[action.kind]}
            </Button>
          ) : null}
          {action.kind === "finalize" ? (
            <Button onClick={onFinalize} disabled={!connected} data-action="finalize">
              Finalize · open {String(action.remaining)}
            </Button>
          ) : null}
          {action.kind === "settle" ? (
            <Button onClick={onSettle} disabled={!connected} data-action="settle">
              Settle · {String(action.pending)} left
            </Button>
          ) : null}
          {action.kind === "bid" ? (
            <p className="text-right text-[12px] text-ink-400">
              closes in <Countdown target={action.closesAt} endedLabel="now" className="text-ink-50" />
            </p>
          ) : null}
          {action.kind === "wait_reveal" ? (
            <p className="text-right text-[12px] text-ink-400">
              clear in <Countdown target={action.until} endedLabel="now" className="text-ink-50" />
            </p>
          ) : null}
          {retryVisible ? (
            <Button variant="secondary" size="sm" onClick={() => void act()} loading={busy} loadingLabel="Signing…" disabled={!connected} data-action="retry-close">
              Retry the key request
            </Button>
          ) : null}
          {canCancelNoKey(round, nowMs) && action.kind !== "cancel_no_key" ? (
            <Button variant="danger" size="sm" onClick={() => void run({ label: "Cancelling (no key)", call: engine.calls.cancelNoKey(round.roundId), success: "Round cancelled", receipt: receipt("cancel", "cancel_no_key") }).then((r) => r.ok && onChanged())} loading={busy} disabled={!connected}>
              Cancel (no key)
            </Button>
          ) : null}
          {canCancelAsCreator(round, viewer?.account ?? null, nowMs) ? (
            confirmCancel ? (
              <div className="flex gap-2">
                <Button variant="danger" size="sm" onClick={() => void cancelAsCreator()} loading={busy} loadingLabel="Signing…">
                  Confirm withdrawal
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>
                  Keep
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(true)}>
                Withdraw round (no orders yet)
              </Button>
            )
          ) : null}
          {!connected && action.kind !== "done" && action.kind !== "wait_open" ? <p className="text-right text-[11px] text-ink-500">Connect a NEAR wallet to act.</p> : null}
          {status.status === "error" ? <Notice tone="danger" className="max-w-xs">{status.error.message}</Notice> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-750 px-4 py-2 text-[11px] text-ink-500">
        <span>
          key timeout {formatDuration(Number(round.keyTimeout) / 1e9)} · reveal window {formatDuration(Number(round.revealWindow) / 1e9)}
        </span>
        <a href={nearAccountUrl(engine.account)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
          engine {engine.account} ↗
        </a>
        <LearnMore topic="sealedRounds" anchor="lifecycle" />
      </div>
    </section>
  );
}
