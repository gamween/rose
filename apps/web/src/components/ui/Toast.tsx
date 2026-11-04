"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

export type ToastTone = "info" | "success" | "error" | "pending";

export type ExplorerLink = { href: string; label: string };

export type ToastInput = {
  tone: ToastTone;
  title: string;
  description?: string;
  /** Links to block explorers (one per chain touched by the action). */
  links?: ExplorerLink[];
  /** Milliseconds before auto-dismiss; pending toasts stay until updated. */
  duration?: number;
};

export type Toast = ToastInput & { id: number };

type ToastApi = {
  show: (toast: ToastInput) => number;
  update: (id: number, toast: ToastInput) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION: Record<ToastTone, number | null> = { info: 6000, success: 8000, error: 12000, pending: null };

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const schedule = useCallback(
    (id: number, toast: ToastInput) => {
      const existing = timers.current.get(id);
      if (existing !== undefined) window.clearTimeout(existing);
      const duration = toast.duration ?? DEFAULT_DURATION[toast.tone];
      if (duration !== null) timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
    },
    [dismiss],
  );

  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current.slice(-4), { ...toast, id }]);
      schedule(id, toast);
      return id;
    },
    [schedule],
  );

  const update = useCallback(
    (id: number, toast: ToastInput) => {
      setToasts((current) => current.map((item) => (item.id === id ? { ...toast, id } : item)));
      schedule(id, toast);
    },
    [schedule],
  );

  useEffect(() => {
    const active = timers.current;
    return () => active.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const api = useMemo(() => ({ show, update, dismiss }), [show, update, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ol
        aria-live="polite"
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[100] flex flex-col items-end gap-2 sm:left-auto sm:w-[380px]"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </ol>
    </ToastContext.Provider>
  );
}

const toneStyles: Record<ToastTone, { bar: string; icon: string }> = {
  info: { bar: "bg-info-400", icon: "text-info-400" },
  success: { bar: "bg-success-400", icon: "text-success-400" },
  error: { bar: "bg-danger-400", icon: "text-danger-400" },
  pending: { bar: "bg-ember-400", icon: "text-ember-400" },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const style = toneStyles[toast.tone];
  return (
    <li
      role={toast.tone === "error" ? "alert" : "status"}
      className="pointer-events-auto relative flex w-full animate-toast-in gap-3 overflow-hidden rounded-md border border-ink-700 bg-ink-850 py-3 pl-4 pr-3 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.8)]"
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", style.bar)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {toast.tone === "pending" ? <Spinner className={style.icon} label="Pending" /> : null}
          <p className="text-[13px] font-medium text-ink-50">{toast.title}</p>
        </div>
        {toast.description ? <p className="mt-1 break-words text-[12px] text-ink-300">{toast.description}</p> : null}
        {toast.links && toast.links.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {toast.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="font-display text-[11px] uppercase tracking-wide text-ember-300 underline-offset-2 hover:underline"
              >
                {link.label} ↗
              </a>
            ))}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-400 hover:bg-ink-800 hover:text-ink-100"
      >
        <svg viewBox="0 0 8 8" width="8" height="8" shapeRendering="crispEdges" aria-hidden>
          <path d="M0 0h1v1H0zM1 1h1v1H1zM2 2h1v1H2zM3 3h2v2H3zM5 2h1v1H5zM6 1h1v1H6zM7 0h1v1H7zM2 5h1v1H2zM1 6h1v1H1zM0 7h1v1H0zM5 5h1v1H5zM6 6h1v1H6zM7 7h1v1H7z" fill="currentColor" />
        </svg>
      </button>
    </li>
  );
}
