"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useWallets } from "@/components/wallet/WalletProvider";
import { ChainLogo } from "@/components/wallet/ChainLogo";
import { WalletsStatusRow } from "@/components/wallet/WalletsStatus";
import { cn } from "@/lib/cn";
import { shortHex } from "@/lib/amounts";
import { CHAIN_LABEL, type ChainId } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";
import type { Verdict } from "./eligibility";

export type DepositChain = "base" | "solana";

export function ChainPicker({ value, onChange, deployed }: { value: DepositChain | null; onChange: (chain: DepositChain) => void; deployed: Record<DepositChain, string | null> }) {
  const options: { id: DepositChain; title: string; body: string }[] = [
    { id: "base", title: "Base Sepolia", body: "Sablier streams" },
    { id: "solana", title: "Solana devnet", body: "Streamflow streams" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Chain of the position">
      {options.map((option) => {
        const missing = deployed[option.id];
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            data-chain={option.id}
            onClick={() => onChange(option.id)}
            className={cn(
              "ui-surface relative flex flex-col gap-1 rounded-lg px-4 py-3 text-left transition-colors",
              selected ? "border-ember-500 bg-ember-700/10 before:absolute before:inset-x-0 before:-top-px before:h-[2px] before:rounded-t-lg before:bg-ember-500" : "hover:border-ink-600 hover:bg-ink-800/60",
            )}
          >
            <span className="flex items-center gap-2.5 text-[13px] text-ink-50 font-semibold">
              <span aria-hidden className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-[2px] border", selected ? "border-ember-400 bg-(--surface-inset)" : "border-ink-600 bg-(--surface-inset)")}>
                {selected ? <span className="size-1.5 bg-ember-400" /> : null}
              </span>
              <ChainLogo chain={option.id} size={16} />
              {option.title}
              {missing ? <Badge tone="warning">Not deployed</Badge> : null}
            </span>
            <span className="pl-6 text-[12px] leading-snug text-ink-400">{option.body}</span>
            {missing ? <span className="pl-6 text-[11px] text-warning-400">{missing}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function WalletPrompt({ chain, onConnect, children }: { chain: ChainId; onConnect: (chain: ChainId) => void; children?: ReactNode }) {
  const { restoring } = useWallets();
  if (restoring) return <WalletsStatusRow what="Restoring your wallet…" />;
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-ink-600 bg-(--surface-inset) px-4 py-3">
      <p className="text-[13px] text-ink-100">{children ?? `A ${CHAIN_LABEL[chain]} wallet is needed for this step.`}</p>
      <Button size="sm" variant="secondary" onClick={() => onConnect(chain)} data-connect-prompt={chain}>
        Connect a {CHAIN_LABEL[chain]} wallet
      </Button>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return verdict.eligible ? <Badge tone="success">Eligible</Badge> : <Badge tone="danger">Not eligible</Badge>;
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12px] text-danger-400" aria-label="Why the stream is not eligible">
      {reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  );
}

/** "Joins class …" or "Creates a new class": the class id is deterministic from the schedule. */
function ClassNote({ classId, classExists }: { classId: string | null; classExists: boolean | null }) {
  if (!classId) return null;
  return (
    <p className="text-[12px] text-ink-300">
      {classExists ? "Joins class" : "Creates a new class"}{" "}
      <a href={`${ROUTES.prices}#${classId}`} className="tabular text-ink-100 underline-offset-2 hover:underline" title={classId}>
        {shortHex(classId, 8, 6)}
      </a>
      {classExists ? "" : " (the first deposit registers it)"}
    </p>
  );
}

export function Row({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-[12px]">
      <dt className="shrink-0 text-ink-400">{label}</dt>
      <dd className={cn("min-w-0 text-right text-ink-100 [overflow-wrap:anywhere]", mono && "tabular")} title={typeof value === "string" ? value : undefined}>
        {value}
      </dd>
    </div>
  );
}

/**
 * One stream of the deposit list, as a single row: name, eligibility, the amount and the Deposit
 * button; the reasons it is refused stay visible, the schedule and addresses sit under Details.
 */
export function StreamItem({ id, title, amount, verdict, details, classId, classExists, onDeposit, depositDisabled, disabledReason }: { id: string; title: ReactNode; amount: ReactNode; verdict: Verdict; details: ReactNode; classId: string | null; classExists: boolean | null; onDeposit: () => void; depositDisabled: boolean; disabledReason: string | null }) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2.5" data-stream={id}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink-50">
            <span className="tabular">{title}</span>
            <VerdictBadge verdict={verdict} />
          </p>
          <p className="tabular mt-0.5 text-[12px] text-ink-300">{amount}</p>
        </div>
        <Button size="sm" onClick={onDeposit} disabled={depositDisabled} title={disabledReason ?? undefined} data-deposit-stream>
          Deposit
        </Button>
      </div>
      <Reasons reasons={verdict.reasons} />
      <details className="group" data-stream-details>
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-ink-400 hover:text-ink-100 [&::-webkit-details-marker]:hidden">
          Details
          <span aria-hidden className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="mt-2 flex flex-col gap-2 border-t border-ink-750 pt-2">
          <dl className="grid min-w-0 gap-x-6 gap-y-0.5 sm:grid-cols-2">{details}</dl>
          <ClassNote classId={classId} classExists={classExists} />
        </div>
      </details>
    </li>
  );
}
