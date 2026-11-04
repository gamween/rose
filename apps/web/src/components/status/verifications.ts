import type { StoredEvent } from "./events";
import { formatUnits } from "@/lib/format";
import { shorten } from "./explorers";

/**
 * The outcomes of the engine's ForeignTx proofs (spec 8.3 status: "recent ForeignTx
 * verifications"), from its event history: registered positions and Base cash, attributed
 * Solana streams, confirmed payouts, and the proofs that failed, mismatched or were refused.
 */

export type OutcomeTone = "success" | "danger" | "warning";

export type ForeignTxOutcome = {
  event: StoredEvent;
  tone: OutcomeTone;
  label: string;
  account: string | null;
  /** The class whose decimals format `tokens`, when the outcome registered a position. */
  classId: string | null;
  /** The position's allocation, in token base units. */
  tokens: string | null;
  detail: string;
};

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `BaseLog 0xab12…:3`, `SolStream 9xQe…`, `SolNonce 4f2a…` from a replay key. */
export function replayKeyLabel(key: unknown): string {
  if (typeof key !== "object" || key === null) return "";
  const record = key as Record<string, Record<string, unknown> | undefined>;
  if (record.BaseLog) return `Base log ${shorten(String(record.BaseLog.tx_hash), 6, 4)}:${String(record.BaseLog.log_index)}`;
  if (record.SolStream) return `Solana stream ${shorten(String(record.SolStream.metadata), 4, 4)}`;
  if (record.SolNonce) return `Solana nonce ${shorten(String(record.SolNonce.account), 4, 4)}`;
  return "";
}

/** One outcome, or null for an event that is not the end of a ForeignTx proof. */
export function foreignTxOutcome(event: StoredEvent): ForeignTxOutcome | null {
  const data = event.data;
  const base = { event, account: null, classId: null, tokens: null } as const;
  switch (event.event) {
    /* A verified deposit logs position_registered (the allocation) and deposit_registered (the replay key): one row, from the first. */
    case "position_registered":
      return { ...base, tone: "success", label: `Position #${String(data.position_id)} registered`, account: text(data.depositor), classId: text(data.class_id), tokens: text(data.allocation), detail: "" };
    case "base_cash_registered":
      /* Accepted cash tokens are 6-decimal USDC (rose tUSDC, Circle USDC); another token keeps its base units. */
      return {
        ...base,
        tone: data.accepted === false ? "warning" : "success",
        label: data.accepted === false ? "Base cash (token not accepted for rounds)" : "Base cash",
        account: text(data.account),
        detail: data.accepted === false ? `${String(data.amount)} base units of ${shorten(String(data.token), 6, 4)}` : `${formatUnits(BigInt(String(data.amount)), 6, 2)} USDC of ${shorten(String(data.token), 6, 4)}`,
      };
    case "sol_deposit_attributed":
      return { ...base, tone: "success", label: "Solana stream attributed", account: text(data.account), detail: `stream ${shorten(String(data.metadata), 4, 4)}` };
    case "payout_landed":
      return { ...base, tone: "success", label: `Payout #${String(data.payout_id)} confirmed`, detail: "foreign transaction proven executed" };
    case "deposit_refused":
      return { ...base, tone: "warning", label: "Deposit refused", detail: `${replayKeyLabel(data.key)} · ${String(data.reason)}` };
    case "deposit_verification_failed":
      return { ...base, tone: "danger", label: "Proof failed", detail: `${replayKeyLabel(data.key)} · MPC error or timeout, retryable` };
    case "deposit_mismatch":
      return { ...base, tone: "danger", label: "Mismatch", detail: `${replayKeyLabel(data.key)} · the proven data differs from the claim` };
    default:
      return null;
  }
}

export type OutcomeCounts = { verified: number; refused: number; failed: number };

export function countOutcomes(outcomes: readonly ForeignTxOutcome[]): OutcomeCounts {
  return {
    verified: outcomes.filter((outcome) => outcome.tone === "success" || outcome.label.startsWith("Base cash")).length,
    refused: outcomes.filter((outcome) => outcome.label === "Deposit refused").length,
    failed: outcomes.filter((outcome) => outcome.tone === "danger").length,
  };
}
