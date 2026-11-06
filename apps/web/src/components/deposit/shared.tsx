"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useWallets } from "@/components/wallet/WalletProvider";
import { WalletsStatusRow } from "@/components/wallet/WalletsStatus";
import { cn } from "@/lib/cn";
import { shortHex } from "@/lib/amounts";
import { CHAIN_LABEL, type ChainId } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";
import type { Verdict } from "./eligibility";

export type DepositChain = "base" | "solana";

export function ChainPicker({ value, onChange, deployed }: { value: DepositChain | null; onChange: (chain: DepositChain) => void; deployed: Record<DepositChain, string | null> }) {
  const options: { id: DepositChain; title: string; body: string }[] = [
    { id: "base", title: "Base Sepolia", body: "Sablier Lockup v4 streams (Lockup Linear, transferable, non-cancelable), held by RoseVault." },
    { id: "solana", title: "Solana devnet", body: "Streamflow streams the recipient can transfer and the sender cannot change, held by the engine's vault." },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Chain of the position">
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
              "flex flex-col gap-1 rounded-lg border px-4 py-3 text-left transition-colors",
              selected ? "border-ember-500 bg-ember-700/15" : "border-ink-750 bg-ink-850 hover:border-ink-500 hover:bg-ink-800",
            )}
          >
            <span className="flex items-center gap-2 font-display text-[13px] text-ink-50">
              {option.title}
              {missing ? <Badge tone="warning">Not deployed</Badge> : null}
            </span>
            <span className="text-[12px] text-ink-400">{option.body}</span>
            {missing ? <span className="text-[11px] text-warning-400">{missing}</span> : null}
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
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-ink-600 bg-ink-900 px-4 py-3">
      <p className="text-[13px] text-ink-100">{children ?? `A ${CHAIN_LABEL[chain]} wallet is needed for this step.`}</p>
      <Button size="sm" variant="secondary" onClick={() => onConnect(chain)} data-connect-prompt={chain}>
        Connect a {CHAIN_LABEL[chain]} wallet
      </Button>
    </div>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return verdict.eligible ? <Badge tone="success">Eligible</Badge> : <Badge tone="danger">Not eligible</Badge>;
}

export function Reasons({ reasons }: { reasons: string[] }) {
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
export function ClassNote({ classId, classExists }: { classId: string | null; classExists: boolean | null }) {
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
