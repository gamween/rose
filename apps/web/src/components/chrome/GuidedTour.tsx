"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { VoxelArt, type VoxelPreset } from "@/components/ui/VoxelArt";
import { ROUTES } from "@/lib/routes";
import { LearnMore } from "./LearnMore";

export const TOUR_STORAGE_KEY = "rose.tour.dismissed";
const TOUR_DIALOG_ID = "rose-tour";

/**
 * Runs while the server HTML is parsed, right after the tour: a visitor who dismissed it (or who
 * lands on the guided demo) never sees the server-painted panel.
 */
const PRE_PAINT = `(function(){var d=document.getElementById(${JSON.stringify(TOUR_DIALOG_ID)});if(!d)return;try{if(localStorage.getItem(${JSON.stringify(TOUR_STORAGE_KEY)})==="1"||location.pathname===${JSON.stringify(ROUTES.demo)})d.removeAttribute("open")}catch(e){d.removeAttribute("open")}})()`;

type Step = { title: string; body: string; illustration: VoxelPreset; learn?: Parameters<typeof LearnMore>[0]["topic"] };

const STEPS: Step[] = [
  {
    title: "What was locked, rose.",
    body: "rose runs sealed, uniform-price rounds for locked token allocations. Positions stay on Base or Solana; NEAR holds them through Chain Signatures and settles everything in one ledger. Everything here is on testnets.",
    illustration: "vault",
    learn: "concepts",
  },
  {
    title: "Connect wallets or use demo keys",
    body: "Connect asks for the network first, then the wallet. NEAR is the one you need to trade; Base or Solana only matter if your position lives there. Each network also offers a demo wallet whose key stays in this browser, so you can try a full round without installing anything.",
    illustration: "ledger",
    learn: "wallets",
  },
  {
    title: "Get test funds",
    body: "The testnet banner opens a panel that creates your NEAR demo account, sends Base Sepolia gas and devnet SOL, mints tUSDC on both venues, and mints a demo vesting position to deposit.",
    illustration: "ember",
  },
  {
    title: "Tender, Exit, Advance",
    body: "A Tender buys back units for an issuer, an Exit lets holders of the same allocation sell together, an Advance lends against future unlocks. Bids are sealed with IBE; the MPC releases the round key only after close.",
    illustration: "tender",
    learn: "sealedRounds",
  },
  {
    title: "Everything is verifiable",
    body: "Every action shows an explorer link, the activity feed reads the engine's on-chain history, and the command palette (Cmd+K, or Search in the menu on a phone) jumps anywhere. The Status page checks the engine is keyless.",
    illustration: "exit",
    learn: "trust",
  },
];

export function readTourDismissed(): boolean {
  try {
    return window.localStorage.getItem(TOUR_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function writeTourDismissed(dismissed: boolean): void {
  try {
    if (dismissed) window.localStorage.setItem(TOUR_STORAGE_KEY, "1");
    else window.localStorage.removeItem(TOUR_STORAGE_KEY);
  } catch {
    // Storage unavailable: the tour shows again next visit.
  }
}

/**
 * First-visit guided tour: opens once, dismissable, remembers the dismissal; reopenable from the
 * palette. The server paints its first step with the page (`deciding` holds it until the shell has
 * read the dismissal), then it becomes a regular modal.
 */
export function GuidedTour({ open, onClose, deciding }: { open: boolean; onClose: () => void; deciding: boolean }) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index] ?? STEPS[0];
  if (!step) return null;
  const last = index === STEPS.length - 1;

  const dismiss = () => {
    writeTourDismissed(true);
    setIndex(0);
    onClose();
  };

  return (
    <>
      <Modal
        id={TOUR_DIALOG_ID}
        serverOpen
        holdServerOpen={deciding}
        open={open}
        onClose={dismiss}
        title={step.title}
        description={`Step ${String(index + 1)} of ${String(STEPS.length)}`}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Skip tour
            </Button>
            {index > 0 ? (
              <Button variant="secondary" size="sm" onClick={() => setIndex((i) => Math.max(0, i - 1))}>
                Back
              </Button>
            ) : null}
            <Button size="sm" onClick={() => (last ? dismiss() : setIndex((i) => i + 1))} data-tour-next>
              {last ? "Start" : "Next"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start" data-tour-step={index}>
          <div className="relative flex shrink-0 items-center justify-center">
            <span aria-hidden className="dither-glow absolute size-24 opacity-60" />
            <VoxelArt preset={step.illustration} size={80} className="relative" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] leading-relaxed text-ink-200">{step.body}</p>
            {step.learn ? <LearnMore topic={step.learn} className="mt-3" /> : null}
          </div>
        </div>
        <ol className="mt-4 flex items-center justify-center gap-1.5" aria-hidden>
          {STEPS.map((item, i) => (
            <li key={item.title} className={i === index ? "size-[6px] bg-ember-400" : "size-[6px] bg-ink-600"} />
          ))}
        </ol>
      </Modal>
      <script dangerouslySetInnerHTML={{ __html: PRE_PAINT }} />
    </>
  );
}
