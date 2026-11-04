"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Modal } from "@/components/ui/Modal";
import { useFlow, type StepDefinition } from "@/lib/use-action";

export type FlowRequest = {
  title: string;
  description?: ReactNode;
  /** Built when the dialog opens, so the steps capture the latest data. */
  steps: () => StepDefinition[];
  /** Shown above the steps (amounts, destination), never changes while running. */
  summary?: ReactNode;
};

/**
 * Runs a multi-step flow (claim, redeem, payout submission) in a modal: starts on open, shows
 * every step with explorer links, lets the person retry the failed step, and refreshes the
 * portfolio once the last step is done.
 */
export function FlowDialog({ request, onClose, onDone }: { request: FlowRequest | null; onClose: () => void; onDone: () => void }) {
  const flow = useFlow({ onComplete: onDone });
  const started = useRef<FlowRequest | null>(null);
  const { start, reset } = flow;

  useEffect(() => {
    if (request && started.current !== request) {
      started.current = request;
      void start(request.steps());
    }
    if (!request && started.current) {
      started.current = null;
      reset();
    }
  }, [request, reset, start]);

  const close = () => {
    flow.cancel();
    onClose();
  };

  return (
    <Modal
      open={request !== null}
      onClose={close}
      title={request?.title ?? ""}
      description={request?.description}
      footer={
        <Button variant={flow.completed ? "primary" : "secondary"} onClick={close} data-flow-close>
          {flow.completed ? "Done" : flow.running ? "Close (keeps running on chain)" : "Close"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4" data-flow-dialog data-flow-status={flow.completed ? "completed" : flow.running ? "running" : "idle"}>
        {request?.summary ? <div className="rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px] text-ink-300">{request.summary}</div> : null}
        <FlowSteps steps={flow.steps} running={flow.running} onRetry={() => void flow.retry()} />
      </div>
    </Modal>
  );
}
