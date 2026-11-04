"use client";

/**
 * Hooks behind every async button of the app pages (spec 8.3): one-shot actions with a pending,
 * success and failure state mirrored in a toast with explorer links, and multi-step flows
 * (deposit, claims) that stop at the failing step and resume from it on retry.
 */

import { useCallback, useRef, useState } from "react";
import { useToast, type ExplorerLink } from "@/components/ui/Toast";
import { toActionError, type ActionError } from "./errors";

export type ActionResult = { message: string; links?: ExplorerLink[] };

export type ActionState =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "success"; message: string; links: ExplorerLink[] }
  | { status: "error"; error: ActionError };

/** A single action: `run(label, fn)` shows a pending toast, then success (with links) or a readable error. */
export function useAction(options: { onSuccess?: () => void } = {}): {
  state: ActionState;
  run: (label: string, action: () => Promise<ActionResult>) => Promise<boolean>;
  reset: () => void;
} {
  const { onSuccess } = options;
  const [state, setState] = useState<ActionState>({ status: "idle" });
  const toast = useToast();
  const run = useCallback(
    async (label: string, action: () => Promise<ActionResult>) => {
      setState({ status: "loading", label });
      const pending = toast.show({ tone: "pending", title: label });
      try {
        const result = await action();
        const links = result.links ?? [];
        setState({ status: "success", message: result.message, links });
        toast.update(pending, { tone: "success", title: result.message, links });
        onSuccess?.();
        return true;
      } catch (error) {
        const described = toActionError(error);
        setState({ status: "error", error: described });
        toast.update(pending, { tone: "error", title: described.title, description: described.message });
        return false;
      }
    },
    [onSuccess, toast],
  );
  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset };
}

export type StepStatus = "idle" | "running" | "done" | "error";

export type FlowStep = {
  id: string;
  label: string;
  status: StepStatus;
  /** Live progress text while running, result text once done. */
  detail: string | null;
  links: ExplorerLink[];
  error: ActionError | null;
};

export type StepContext = {
  /** Replaces the live progress text of the step. */
  setDetail: (detail: string) => void;
  /** Adds explorer links to the step as they become known. */
  addLinks: (links: ExplorerLink[]) => void;
  signal: AbortSignal;
};

export type StepDefinition = {
  id: string;
  label: string;
  /** Returns the final detail text of the step (and optional links). */
  run: (context: StepContext) => Promise<ActionResult | void>;
};

/**
 * A sequential multi-step flow. `start` runs every step in order and stops at the first failure;
 * `retry` resumes from the failed step (every step is written to be idempotent or safe to re-run).
 */
export function useFlow(options: { onComplete?: () => void } = {}): {
  steps: FlowStep[];
  running: boolean;
  completed: boolean;
  start: (definitions: StepDefinition[]) => Promise<void>;
  retry: () => Promise<void>;
  cancel: () => void;
  reset: () => void;
} {
  const { onComplete } = options;
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState(false);
  const definitionsRef = useRef<StepDefinition[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const toast = useToast();

  const patch = useCallback((id: string, update: Partial<FlowStep> | ((step: FlowStep) => Partial<FlowStep>)) => {
    setSteps((current) => current.map((step) => (step.id === id ? { ...step, ...(typeof update === "function" ? update(step) : update) } : step)));
  }, []);

  const runFrom = useCallback(
    async (index: number) => {
      const definitions = definitionsRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      setRunning(true);
      for (let i = index; i < definitions.length; i += 1) {
        const definition = definitions[i];
        if (!definition || controller.signal.aborted) break;
        patch(definition.id, { status: "running", error: null, detail: null });
        const pending = toast.show({ tone: "pending", title: definition.label });
        try {
          const result = await definition.run({
            setDetail: (detail) => patch(definition.id, { detail }),
            addLinks: (links) => patch(definition.id, (step) => ({ links: [...step.links, ...links] })),
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            toast.dismiss(pending);
            break;
          }
          const links = result?.links ?? [];
          patch(definition.id, (step) => ({ status: "done", detail: result?.message ?? step.detail, links: [...step.links, ...links] }));
          toast.update(pending, { tone: "success", title: result?.message ?? `${definition.label}: done`, links });
          if (i === definitions.length - 1) {
            setCompleted(true);
            onComplete?.();
          }
        } catch (error) {
          if (controller.signal.aborted) {
            toast.dismiss(pending);
            break;
          }
          const described = toActionError(error);
          patch(definition.id, { status: "error", error: described });
          toast.update(pending, { tone: "error", title: described.title, description: described.message });
          break;
        }
      }
      if (!controller.signal.aborted) setRunning(false);
    },
    [onComplete, patch, toast],
  );

  const start = useCallback(
    async (definitions: StepDefinition[]) => {
      controllerRef.current?.abort();
      definitionsRef.current = definitions;
      setCompleted(false);
      setSteps(definitions.map((definition) => ({ id: definition.id, label: definition.label, status: "idle", detail: null, links: [], error: null })));
      await runFrom(0);
    },
    [runFrom],
  );

  const retry = useCallback(async () => {
    const failed = steps.findIndex((step) => step.status === "error");
    if (failed < 0) return;
    await runFrom(failed);
  }, [runFrom, steps]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    setRunning(false);
    setSteps((current) => current.map((step) => (step.status === "running" ? { ...step, status: "idle", detail: null } : step)));
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    definitionsRef.current = [];
    setSteps([]);
    setRunning(false);
    setCompleted(false);
  }, []);

  return { steps, running, completed, start, retry, cancel, reset };
}
