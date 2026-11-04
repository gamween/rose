"use client";

import type { RoundKind, RoundStatus } from "@rose/sdk";
import type { ReactNode } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { DEPLOYMENT } from "@/lib/deployment";
import { ROUTES } from "@/lib/routes";
import { KIND_LABEL, STATUS_LABEL, STATUS_TONE } from "./model";

const KIND_TONE: Record<RoundKind, "ember" | "rose" | "info"> = { Tender: "ember", Exit: "rose", Advance: "info" };

export function KindBadge({ kind, className }: { kind: RoundKind; className?: string }) {
  return (
    <Badge tone={KIND_TONE[kind]} className={className}>
      {KIND_LABEL[kind]}
    </Badge>
  );
}

export function StatusBadge({ status, className }: { status: RoundStatus; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status]} className={className} data-status={status}>
      {status === "Open" || status === "KeyRequested" ? <span aria-hidden className={cn("size-[5px]", status === "Open" ? "animate-pulse bg-ember-400" : "animate-pulse bg-warning-400")} /> : null}
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** The engine is not configured or not reachable as a contract: say exactly what is missing. */
export function NotDeployedState({ detail, title = "Engine not deployed yet" }: { detail?: string; title?: string }) {
  const engine = DEPLOYMENT.find((entry) => entry.key === "engineAccount");
  return (
    <EmptyState
      illustration="vault"
      title={title}
      description={
        <>
          Rounds live on the rose-engine contract on NEAR testnet. {detail ?? `Set ${engine?.env ?? "NEXT_PUBLIC_ENGINE_ACCOUNT"} to the deployed account to read them.`} Until then, read how a sealed round works.
        </>
      }
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <ButtonLink href={ROUTES.status} variant="secondary" size="sm">
            Deployment status
          </ButtonLink>
          <LearnMore topic="sealedRounds" className="self-center" />
        </div>
      }
    />
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState
      illustration="ember"
      title="Could not read the engine"
      description={message}
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      }
    />
  );
}

export function LoadingCards({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-[196px] w-full rounded-lg" />
      ))}
    </div>
  );
}

/** Label and value pair for dense parameter grids. */
export function Param({ label, children, className, mono = true }: { label: ReactNode; children: ReactNode; className?: string; mono?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <dt className="font-display text-[10px] uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className={cn("truncate text-[13px] text-ink-100", mono && "tabular")}>{children}</dd>
    </div>
  );
}

/** A one-line inline notice (hint, warning or error) under a control or a section. */
export function Notice({ tone = "info", children, className }: { tone?: "info" | "warning" | "danger" | "success"; children: ReactNode; className?: string }) {
  const tones = {
    info: "border-ink-700 bg-ink-900 text-ink-300",
    warning: "border-warning-400/40 bg-warning-400/10 text-warning-400",
    danger: "border-danger-500/60 bg-danger-500/10 text-danger-400",
    success: "border-success-500/50 bg-success-500/10 text-success-400",
  };
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={cn("rounded-md border px-3 py-2 text-[12px] leading-snug", tones[tone], className)}>
      {children}
    </div>
  );
}
