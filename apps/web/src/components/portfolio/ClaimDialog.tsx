"use client";

import type { Position } from "@rose/sdk";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, NumberInput } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { amountToText, formatAmount, isEvmAddress, isSolanaAddress, parseAmount } from "@/lib/amounts";

export type ClaimPrompt = {
  title: string;
  description: ReactNode;
  /** Amount field: max and decimals; omitted when the amount is fixed. */
  amount?: { max: bigint; decimals: number; unit: string };
  /** Destination field on the foreign chain; `fixed` shows it read-only (a retired lot's `retire_to`). */
  destination?: { chain: "base" | "solana"; initial: string; fixed?: boolean };
  /** Position picker for an in-kind redeem. */
  positions?: { candidates: Position[]; decimals: number; freeUnits: bigint };
  confirmLabel: string;
  onConfirm: (values: { amount: bigint; destination: string; position: Position | null }) => void;
};

/** Collects the amount, destination and position of a claim or redeem before its flow starts. */
export function ClaimDialog({ prompt, onClose }: { prompt: ClaimPrompt | null; onClose: () => void }) {
  if (!prompt) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  return <ClaimForm key={prompt.title} prompt={prompt} onClose={onClose} />;
}

function ClaimForm({ prompt, onClose }: { prompt: ClaimPrompt; onClose: () => void }) {
  const positions = prompt.positions;
  const [amount, setAmount] = useState(() => (prompt.amount ? amountToText(prompt.amount.max, prompt.amount.decimals) : ""));
  const [destination, setDestination] = useState(() => prompt.destination?.initial ?? "");
  const [positionId, setPositionId] = useState<string>(() => positions?.candidates.find((position) => position.allocation <= positions.freeUnits)?.positionId.toString() ?? "");

  const parsedAmount = prompt.amount ? parseAmount(amount, prompt.amount.decimals) : 0n;
  const amountError = prompt.amount
    ? parsedAmount === null
      ? "Enter an amount"
      : parsedAmount === 0n
        ? "The amount must be positive"
        : parsedAmount > prompt.amount.max
          ? `At most ${formatAmount(prompt.amount.max, prompt.amount.decimals)} ${prompt.amount.unit}`
          : undefined
    : undefined;
  const destinationError = prompt.destination
    ? prompt.destination.chain === "base"
      ? isEvmAddress(destination)
        ? undefined
        : "Enter a Base address (0x + 40 hex characters)"
      : isSolanaAddress(destination)
        ? undefined
        : "Enter a Solana address (base58)"
    : undefined;
  const position = positions?.candidates.find((candidate) => candidate.positionId.toString() === positionId) ?? null;
  const positionError = positions ? (position ? (position.allocation > positions.freeUnits ? "Your free units do not cover this position's allocation" : undefined) : "Choose a position") : undefined;
  const valid = !amountError && !destinationError && !positionError;

  return (
    <Modal
      open
      onClose={onClose}
      title={prompt.title}
      description={prompt.description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} data-claim-confirm onClick={() => valid && prompt.onConfirm({ amount: parsedAmount ?? 0n, destination, position })}>
            {prompt.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {positions ? (
          <Field label="Position to redeem" error={positionError} hint={`You hold ${formatAmount(positions.freeUnits, positions.decimals)} free units; the position's full allocation is burned.`}>
            {({ inputId, describedBy, invalid }) => (
              <select
                id={inputId}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={positionId}
                onChange={(event) => setPositionId(event.target.value)}
                className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-[13px] text-ink-50 focus:border-ember-500 focus:outline-none"
              >
                <option value="">Choose…</option>
                {positions.candidates.map((candidate) => (
                  <option key={candidate.positionId.toString()} value={candidate.positionId.toString()} disabled={candidate.allocation > positions.freeUnits}>
                    #{candidate.positionId.toString()} · {candidate.source.kind === "BaseStream" ? `Sablier stream ${candidate.source.streamId.toString()}` : `Streamflow ${candidate.source.metadata.slice(0, 8)}…`} · {formatAmount(candidate.allocation, positions.decimals)} units
                    {candidate.allocation > positions.freeUnits ? " (not enough free units)" : ""}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {prompt.amount ? (
          <Field label="Amount" error={amountError} hint={`Claimable: ${formatAmount(prompt.amount.max, prompt.amount.decimals)} ${prompt.amount.unit}`}>
            {({ inputId, invalid }) => (
              <div className="flex items-center gap-2">
                <NumberInput id={inputId} value={amount} onValueChange={setAmount} unit={prompt.amount!.unit} decimals={prompt.amount!.decimals} invalid={invalid} className="flex-1" />
                <Button size="md" variant="ghost" onClick={() => setAmount(amountToText(prompt.amount!.max, prompt.amount!.decimals))}>
                  Max
                </Button>
              </div>
            )}
          </Field>
        ) : null}
        {prompt.destination ? (
          <Field
            label={prompt.destination.chain === "base" ? "Destination on Base Sepolia" : "Destination on Solana devnet"}
            error={destinationError}
            hint={prompt.destination.fixed ? "Fixed by the Tender: a retired lot is payable only to its retire_to address." : "Prefilled with your connected wallet; any address works, the claimant pays the foreign gas."}
          >
            {({ inputId, describedBy, invalid }) => (
              <Input id={inputId} aria-describedby={describedBy} invalid={invalid} value={destination} onChange={(event) => setDestination(event.target.value.trim())} readOnly={prompt.destination?.fixed} spellCheck={false} className="tabular" />
            )}
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}
