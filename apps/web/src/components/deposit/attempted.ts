/**
 * The deposits this browser attempted, kept in `localStorage` so the "Refused deposits" panel
 * can look each one up on the engine (`get_refused_deposit` is keyed by the foreign fact, and no
 * view lists refusals per account) and offer "Return my stream" after a reload, and so a deposit
 * interrupted before its registration (a Base log not registered, a Solana stream that left the
 * wallet) can be resumed after a reload.
 */

import type { ReplayKey, ReplayStateView } from "@rose/sdk";

export const ATTEMPTED_DEPOSITS_KEY = "rose.deposits.attempted";

export type AttemptedDeposit = {
  key: ReplayKey;
  chain: "base" | "solana";
  /** `Sablier stream #82` or `Streamflow stream 5bWq…9fQ2`. */
  label: string;
  nearAccount: string;
  attemptedAt: number;
  /** Base deposits only: the `depositStream` transaction and stream id, so a registration interrupted by a reload can be resumed. */
  baseTx?: string;
  streamId?: string;
  /** Solana deposits only: the class the stream joins, recorded before it leaves the wallet, so an interrupted deposit can be resumed. */
  solClassId?: string;
  /**
   * Base cash deposits only (`depositCash`, with `baseTx`): recorded once the receipt is read, so
   * a registration interrupted by a reload during the finality wait can be resumed.
   */
  cash?: BaseCashAttempt;
};

export type BaseCashAttempt = {
  /** The NEAR account the `CashDeposited` log credits (`nearAccount` of the log). */
  creditTo: string;
  roundId: string;
  /** The ERC-20 deposited, `0x` lowercase. */
  token: string;
  /** Base units, as a decimal string. */
  amount: string;
};

/** Whether the engine still has to register a recorded deposit: no replay record (or one in flight) and no refusal. */
export function awaitsRegistration(replay: ReplayStateView | null, refused: unknown): boolean {
  return replay !== "Consumed" && refused === null;
}

/** The `CashDeposited` log of a recorded cash attempt: RoseVault's log at the recorded block-level index, never another contract's. */
export function matchCashLog<L extends { logIndex: number; address: string }>(logs: readonly L[], key: ReplayKey, vault: string): L | null {
  if (!("BaseLog" in key)) return null;
  return logs.find((log) => log.logIndex === key.BaseLog.log_index && log.address.toLowerCase() === vault.toLowerCase()) ?? null;
}

/** The Base cash deposits of `list` (`depositCash` with its transaction recorded). */
export function cashAttempts(list: readonly AttemptedDeposit[], filter: { token?: string; creditTo?: string } = {}): (AttemptedDeposit & { baseTx: string; cash: BaseCashAttempt })[] {
  return list.flatMap((attempt) => {
    const { cash, baseTx } = attempt;
    if (attempt.chain !== "base" || !cash || !baseTx) return [];
    if (filter.token && cash.token.toLowerCase() !== filter.token.toLowerCase()) return [];
    if (filter.creditTo && cash.creditTo !== filter.creditTo) return [];
    return [{ ...attempt, baseTx, cash }];
  });
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function keyId(key: ReplayKey): string {
  if ("BaseLog" in key) return `base:${key.BaseLog.tx_hash}:${String(key.BaseLog.log_index)}`;
  if ("SolStream" in key) return `sol:${key.SolStream.metadata}`;
  return `nonce:${key.SolNonce.account}:${key.SolNonce.value}`;
}

export function loadAttempted(): AttemptedDeposit[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(ATTEMPTED_DEPOSITS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AttemptedDeposit[]) : [];
  } catch {
    return [];
  }
}

function save(list: AttemptedDeposit[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(ATTEMPTED_DEPOSITS_KEY, JSON.stringify(list));
  } catch {
    // Blocked storage: the refused-deposit panel then only knows about this session.
  }
}

/** Records one attempt (replacing an earlier record of the same key), newest first. */
export function recordAttempted(deposit: AttemptedDeposit): AttemptedDeposit[] {
  const id = keyId(deposit.key);
  const list = [deposit, ...loadAttempted().filter((item) => keyId(item.key) !== id)].slice(0, 50);
  save(list);
  return list;
}

export function forgetAttempted(key: ReplayKey): AttemptedDeposit[] {
  const id = keyId(key);
  const list = loadAttempted().filter((item) => keyId(item.key) !== id);
  save(list);
  return list;
}
