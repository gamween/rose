"use client";

import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import type { QueryState } from "./useLiveQuery";

/** One monitored item: a frame with loading, "not deployed yet", error (with retry) and live states. */
export function StatusBlock<T>({
  title,
  description,
  state,
  retry,
  refreshing,
  notDeployedHint,
  badge,
  loadingHeight,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  state: QueryState<T>;
  retry: () => void;
  refreshing: boolean;
  /** What appears here once the deployment exists. */
  notDeployedHint: string;
  /** Body height (px) of the loaded block at its narrowest, reserved while loading so nothing shifts. */
  loadingHeight?: number;
  /** Headline badge derived from a live value. */
  badge?: (value: T) => { tone: BadgeTone; label: string };
  children: (value: T) => ReactNode;
  className?: string;
}) {
  const live = state.status === "ok" ? badge?.(state.value) : undefined;
  const tone: BadgeTone | null = state.status === "not_deployed" ? "warning" : state.status === "error" ? "danger" : null;
  return (
    <section
      aria-labelledby={`status-${slug(title)}`}
      aria-busy={state.status === "loading" || refreshing}
      className={cn("flex min-w-0 flex-col rounded-lg border border-ink-750 bg-ink-850", className)}
      data-status={state.status}
    >
      <header className="flex items-start justify-between gap-3 border-b border-ink-750 px-4 py-3">
        <div className="min-w-0">
          <h2 id={`status-${slug(title)}`} className="font-display text-[13px] uppercase tracking-wide text-ink-100">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-[12px] text-ink-400">{description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {live ? <Badge tone={live.tone}>{live.label}</Badge> : null}
          {tone ? <Badge tone={tone}>{state.status === "not_deployed" ? "Not deployed yet" : "Unreachable"}</Badge> : null}
          {refreshing && state.status === "ok" ? <span className="size-1.5 animate-pulse bg-ember-400" aria-label="Refreshing" role="status" /> : null}
        </div>
      </header>
      <div className={cn("flex-1 p-4 text-[13px] text-ink-200 transition-opacity", refreshing && state.status === "ok" && "opacity-70")} style={state.status === "loading" && loadingHeight ? { minHeight: loadingHeight } : undefined}>
        {state.status === "loading" ? (
          <div className="flex flex-col gap-2" aria-label="Loading">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : null}
        {state.status === "not_deployed" ? (
          <div className="flex flex-col gap-2">
            <p className="text-ink-300">{state.detail}</p>
            <p className="text-[12px] text-ink-400">{notDeployedHint}</p>
          </div>
        ) : null}
        {state.status === "error" ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-danger-400" role="alert">
              {state.message}
            </p>
            <Button variant="secondary" size="sm" onClick={retry} loading={refreshing} loadingLabel="Retrying">
              Retry
            </Button>
          </div>
        ) : null}
        {state.status === "ok" ? children(state.value) : null}
      </div>
      {state.status === "ok" ? (
        <footer className="border-t border-ink-800 px-4 py-2 text-[11px] text-ink-400">
          Read at <time dateTime={new Date(state.fetchedAt).toISOString()}>{new Date(state.fetchedAt).toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC</time>
        </footer>
      ) : state.status === "loading" ? (
        <footer className="border-t border-ink-800 px-4 py-2 text-[11px] text-ink-400">Reading…</footer>
      ) : null}
    </section>
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Label and value rows inside a block. */
export function Rows({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2">{children}</dl>;
}

export function Row({ label, children, mono = false }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="font-display text-[11px] uppercase leading-5 tracking-wide text-ink-400">{label}</dt>
      <dd className={cn("min-w-0 leading-5 text-ink-100", mono && "font-mono text-[12px] break-all")}>{children}</dd>
    </>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn("text-ember-300 underline decoration-ember-700 underline-offset-4 hover:text-ember-200", className)}>
      {children}
    </a>
  );
}

/** A collapsible raw JSON payload, for the readers who want the RPC result itself. */
export function RawResult({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="mt-3 rounded-md border border-ink-750 bg-ink-900">
      <summary className="cursor-pointer px-3 py-1.5 font-display text-[11px] uppercase tracking-wide text-ink-400 hover:text-ink-100">{label}</summary>
      <pre className="overflow-x-auto px-3 pb-3 font-mono text-[11.5px] leading-relaxed text-ink-200">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
