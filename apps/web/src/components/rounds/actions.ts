"use client";

/**
 * One way to run an engine transaction from the Rounds pages: a pending toast while the wallet
 * signs and the chain executes, a success toast with explorer links, a human-readable error
 * toast otherwise (spec 8.3), and a receipt kept in the browser for the settlement links.
 */

import type { FinalExecutionOutcome, FunctionCall } from "@rose/sdk";
import { useCallback, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useWallets } from "@/components/wallet/WalletProvider";
import { toActionError, type ActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { addReceipt, type ReceiptKind } from "./localOrders";

export interface NearActionOptions {
  /** Toast title while pending ("Closing round #4"). */
  label: string;
  call: FunctionCall;
  /** Toast title on success. */
  success: string | ((outcome: FinalExecutionOutcome) => string);
  description?: string;
  /** Keeps the transaction hash with the round so the settlement panel can link it. */
  receipt?: { engine: string; roundId: bigint; kind: ReceiptKind; label: string };
  /** Shown instead of a toast for failures the caller renders inline (the toast still appears). */
  silentError?: boolean;
}

export type ActionOutcome = { ok: true; outcome: FinalExecutionOutcome; hash: string } | { ok: false; error: ActionError };

export type ActionStatus = { status: "idle" } | { status: "busy"; label: string } | { status: "error"; error: ActionError } | { status: "done"; hash: string };

/** Runs NEAR function calls through whichever NEAR wallet is connected, with toasts and receipts. */
export function useNearAction(): { run: (options: NearActionOptions) => Promise<ActionOutcome>; status: ActionStatus; reset: () => void } {
  const toast = useToast();
  const { sendNearCall } = useWallets();
  const [status, setStatus] = useState<ActionStatus>({ status: "idle" });

  const run = useCallback(
    async (options: NearActionOptions): Promise<ActionOutcome> => {
      setStatus({ status: "busy", label: options.label });
      const pending = toast.show({ tone: "pending", title: options.label, description: options.description });
      try {
        const outcome = await sendNearCall(options.call);
        const hash = outcome.transaction.hash;
        const links = txLinks("near", hash);
        const title = typeof options.success === "function" ? options.success(outcome) : options.success;
        toast.update(pending, { tone: "success", title, links });
        if (options.receipt) {
          addReceipt(options.receipt.engine, options.receipt.roundId, { kind: options.receipt.kind, chain: "near", hash, at: Date.now(), label: options.receipt.label });
        }
        setStatus({ status: "done", hash });
        return { ok: true, outcome, hash };
      } catch (error) {
        const described = toActionError(error);
        toast.update(pending, { tone: "error", title: described.title, description: described.message });
        setStatus({ status: "error", error: described });
        return { ok: false, error: described };
      }
    },
    [sendNearCall, toast],
  );

  const reset = useCallback(() => setStatus({ status: "idle" }), []);
  return { run, status, reset };
}
