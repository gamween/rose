"use client";

/**
 * The action card of a round once bidding is over (spec 5.6, 8.3): what whoever is looking can do
 * now, with its one button. "Close round" after `closes_at`, the key request and its fallback
 * submission, "Open every order" while revealing (the opening progress), "Clear" after the window,
 * "Settle" afterwards, "Cancel (no key)" when the MPC never answered. While bidding is open the
 * order form is the action card and `RoundExtraActions` carries the creator's withdrawal.
 */

import { GAS, TGAS, type Round } from "@rose/sdk";
import { useState, type ReactNode } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { ActionCard } from "@/components/ui/ActionCard";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { useWallets } from "@/components/wallet/WalletProvider";
import { ROUTES } from "@/lib/routes";
import { useNearAction } from "./actions";
import { canCancelAsCreator, canCancelNoKey, canClose, formatDateTime, msToNs, NEXT_ACTION_LABEL, nextAction, OPENING_COST_NEAR, type NextAction } from "./model";
import { Notice } from "./shared";
import { SubmitKeyPanel } from "./SubmitKeyPanel";
import type { RoundDetail } from "./useRoundDetail";

const CLOSE_TGAS = (GAS.close / TGAS).toString();

/** One title and one short line per state; the details sit behind the Learn more link and the Details tab. */
function describe(action: NextAction, round: Round): { title: string; body: string } {
  switch (action.kind) {
    case "wait_open":
      return { title: "Not open yet", body: `Orders are accepted from ${formatDateTime(action.at)}.` };
    case "bid":
      return { title: "Bidding is open", body: "Prices and exact quantities stay sealed until the close." };
    case "close":
      return round.bidCount === 0
        ? { title: "The round has closed without orders", body: `Anyone can close it: with nothing to reveal, closing cancels it (${CLOSE_TGAS} Tgas prepaid).` }
        : { title: "The round has closed", body: `Anyone can close it: this asks the NEAR MPC for the round key, about 5 s (${CLOSE_TGAS} Tgas prepaid).` };
    case "waiting_key":
      return { title: "Key requested from the MPC", body: "The key usually arrives in 4 to 6 s. Without it, anyone can cancel after the timeout." };
    case "cancel_no_key":
      return round.status === "Open"
        ? { title: "Key timeout passed without a close", body: "The round can no longer ask for its key. Anyone can cancel it; everything becomes refundable." }
        : { title: "No key within the timeout", body: "Anyone can cancel the round; every escrow, bond and locked unit becomes refundable." };
    case "finalize":
      return { title: `${String(action.remaining)} sealed ${action.remaining === 1 ? "order" : "orders"} to open`, body: `The key is public: open every order from this browser (about ${OPENING_COST_NEAR} NEAR of gas each).` };
    case "wait_reveal":
      return { title: "Every order is open", body: "Clearing can run once the reveal window ends." };
    case "clear":
      return { title: "Ready to clear", body: "Anyone can compute the clearing price and every fill in one transaction." };
    case "settle":
      return { title: `${String(action.pending)} ${action.pending === 1 ? "order" : "orders"} to settle`, body: "Settlement is per order and open to anyone: units, cash, refunds and bonds go back to each participant." };
    case "done":
      return { title: "Every order is settled", body: "Cash and units are in the NEAR ledger; claim them or pull tokens to Base and Solana from the Portfolio." };
  }
}

/**
 * The next step of a round past its bidding phase as the page's action card. `onSettle` shows
 * where orders settle (My orders or Results); `children` is the opening progress while revealing.
 */
export function RoundAction({ detail, nowMs, onChanged, onSettle, children }: { detail: RoundDetail; nowMs: number; onChanged: () => void; onSettle: () => void; children?: ReactNode }) {
  const { round, engine, viewer } = detail;
  const { restoring } = useWallets();
  const action = nextAction(round, nowMs);
  const text = describe(action, round);
  const { run, status } = useNearAction();
  const busy = status.status === "busy";
  const connected = viewer !== null;
  const receipt = (kind: "close" | "clear" | "cancel", label: string) => ({ engine: engine.account, roundId: round.roundId, kind, label });

  const act = async () => {
    const id = round.roundId;
    let result;
    switch (action.kind) {
      case "close":
        result = await run({
          label: `Closing round #${id.toString()}`,
          call: engine.calls.close(id),
          success: round.bidCount === 0 ? "Round closed without orders: it is cancelled" : "Round closed, key requested from the MPC",
          receipt: receipt("close", "close"),
        });
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

  // `close` refuses a round with orders once its key timeout has passed: no retry is offered then.
  const retryVisible = action.kind === "waiting_key" && nowMs - action.since > 30_000 && canClose(round, nowMs);
  const needsWallet = action.kind === "close" || action.kind === "cancel_no_key" || action.kind === "clear" || action.kind === "finalize" || action.kind === "settle" || retryVisible;

  return (
    <ActionCard
      title={<span data-next-action={action.kind}>{text.title}</span>}
      aria-label="Next step"
      data-round-action={action.kind}
      footer={<LearnMore topic="sealedRounds" anchor="lifecycle" label="How a round ends" />}
    >
      <p className="text-[12.5px] leading-snug text-ink-300">{text.body}</p>
      {action.kind === "waiting_key" ? (
        <p className="tabular mt-2 text-[12px] text-ink-400">
          cancel possible in <Countdown target={action.cancelAt} endedLabel="now" className="text-ink-100" />
          {msToNs(nowMs) >= round.closesAt + round.keyTimeout ? " (the last key request is still in flight)" : null}
        </p>
      ) : null}
      {action.kind === "wait_reveal" ? (
        <p className="tabular mt-2 text-[12px] text-ink-400">
          clear in <Countdown target={action.until} endedLabel="now" className="text-ink-100" />
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-2">
        {action.kind === "close" || action.kind === "cancel_no_key" || action.kind === "clear" ? (
          <Button size="lg" className="w-full" onClick={() => void act()} loading={busy} loadingLabel="Signing…" disabled={!connected} variant={action.kind === "cancel_no_key" ? "danger" : "primary"} data-action={action.kind}>
            {NEXT_ACTION_LABEL[action.kind]}
          </Button>
        ) : null}
        {action.kind === "settle" ? (
          <Button size="lg" className="w-full" onClick={onSettle} data-action="settle">
            Settle · {String(action.pending)} left
          </Button>
        ) : null}
        {action.kind === "done" ? (
          <ButtonLink href={`${ROUTES.portfolio}#claims`} size="lg" variant="secondary" className="w-full" data-action="portfolio">
            Claim in the Portfolio
          </ButtonLink>
        ) : null}
        {retryVisible ? (
          <Button variant="secondary" size="sm" onClick={() => void act()} loading={busy} loadingLabel="Signing…" disabled={!connected} data-action="retry-close">
            Retry the key request
          </Button>
        ) : null}
        {canCancelNoKey(round, nowMs) && action.kind !== "cancel_no_key" ? <CancelNoKeyButton detail={detail} onChanged={onChanged} /> : null}
        {!connected && needsWallet ? <p className="text-[11.5px] text-ink-400">{restoring ? "Restoring your wallet…" : "Connect a NEAR wallet to act."}</p> : null}
        {status.status === "error" ? <Notice tone="danger">{status.error.message}</Notice> : null}
      </div>
      {round.status === "KeyRequested" && round.key === null ? <SubmitKeyPanel detail={detail} onChanged={onChanged} /> : null}
      {children}
    </ActionCard>
  );
}

function CancelNoKeyButton({ detail, onChanged }: { detail: RoundDetail; onChanged: () => void }) {
  const { round, engine, viewer } = detail;
  const { run, status } = useNearAction();
  return (
    <>
      <Button
        variant="danger"
        size="sm"
        onClick={() => void run({ label: "Cancelling (no key)", call: engine.calls.cancelNoKey(round.roundId), success: "Round cancelled", receipt: { engine: engine.account, roundId: round.roundId, kind: "cancel", label: "cancel_no_key" } }).then((r) => r.ok && onChanged())}
        loading={status.status === "busy"}
        disabled={viewer === null}
      >
        Cancel (no key)
      </Button>
      {status.status === "error" ? <Notice tone="danger">{status.error.message}</Notice> : null}
    </>
  );
}

/** The secondary round actions while bidding is open: the creator's withdrawal before the first order. Renders nothing otherwise. */
export function RoundExtraActions({ detail, nowMs, onChanged }: { detail: RoundDetail; nowMs: number; onChanged: () => void }) {
  const { round, engine, viewer } = detail;
  const { run, status } = useNearAction();
  const [confirm, setConfirm] = useState(false);
  if (!canCancelAsCreator(round, viewer?.account ?? null, nowMs)) return null;
  const withdraw = async () => {
    const result = await run({ label: `Withdrawing round #${round.roundId.toString()}`, call: engine.calls.cancelRound(round.roundId), success: "Round withdrawn", receipt: { engine: engine.account, roundId: round.roundId, kind: "cancel", label: "cancel_round" } });
    if (result.ok) onChanged();
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-ink-750 bg-ink-900 px-4 py-3" data-creator-actions>
      <p className="text-[12px] text-ink-400">You created this round. Until the first order you can withdraw it.</p>
      {confirm ? (
        <div className="flex gap-2">
          <Button variant="danger" size="sm" onClick={() => void withdraw()} loading={status.status === "busy"} loadingLabel="Signing…">
            Confirm withdrawal
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setConfirm(true)}>
          Withdraw round
        </Button>
      )}
      {status.status === "error" ? <Notice tone="danger">{status.error.message}</Notice> : null}
    </div>
  );
}
