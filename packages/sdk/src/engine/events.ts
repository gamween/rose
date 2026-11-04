/**
 * NEP-297 event decoding for the engine's own events (`standard: "rose"`) and its NEP-245
 * multi-token events, from raw receipt logs (`EVENT_JSON:{...}`).
 *
 * @module
 */

import type { AccountId, ReplayKey, RoseEventName, RoseEventView, U128, Venue } from "./types.js";

export const EVENT_JSON_PREFIX = "EVENT_JSON:";
export const ROSE_EVENT_STANDARD = "rose";
export const NEP245_STANDARD = "nep245";

/** One NEP-245 `mt_mint` or `mt_burn` entry. */
export interface MtMintBurnEntry { owner_id: AccountId; token_ids: string[]; amounts: U128[]; memo?: string }
/** One NEP-245 `mt_transfer` entry. */
export interface MtTransferEntry {
  old_owner_id: AccountId;
  new_owner_id: AccountId;
  token_ids: string[];
  amounts: U128[];
  authorized_id?: AccountId;
  memo?: string;
}

export type Nep245Event =
  | { event: "mt_mint"; data: MtMintBurnEntry[] }
  | { event: "mt_burn"; data: MtMintBurnEntry[] }
  | { event: "mt_transfer"; data: MtTransferEntry[] };

/** A decoded event log of either standard. */
export type DecodedEvent =
  | { standard: "rose"; version: string; event: RoseEventView }
  | { standard: "nep245"; version: string; event: Nep245Event }
  | { standard: string; version: string; event: { event: string; data: unknown } };

const ROSE_EVENT_NAMES: ReadonlySet<string> = new Set<RoseEventName>([
  "class_created",
  "position_registered",
  "position_released",
  "units_minted",
  "units_burned",
  "units_transferred",
  "cash_deposited",
  "cash_withdrawn",
  "cash_withdrawal_failed",
  "round_created",
  "bid_placed",
  "round_cancelled",
  "key_requested",
  "key_request_failed",
  "key_ignored",
  "clearing_failed",
  "storage_deposited",
  "storage_withdrawn",
  "storage_unregistered",
  "key_received",
  "bid_opened",
  "round_cleared",
  "bid_settled",
  "lien_created",
  "lien_released",
  "claimable_taken",
  "bootstrap_requested",
  "bootstrapped",
  "bootstrap_failed",
  "deposit_verification_requested",
  "deposit_verification_failed",
  "deposit_mismatch",
  "deposit_refused",
  "deposit_registered",
  "base_cash_registered",
  "sol_deposit_attributed",
  "payout_requested",
  "payout_signed",
  "payout_awaiting_gas_signature",
  "payout_failed",
  "payout_landed",
  "payout_cancelling",
  "position_release_requested",
]);

/** Whether `name` is one of the engine's documented event names. */
export function isRoseEventName(name: string): name is RoseEventName {
  return ROSE_EVENT_NAMES.has(name);
}

/** Decodes one log line; returns null for logs that are not NEP-297 events. */
export function decodeEventLog(log: string): DecodedEvent | null {
  if (!log.startsWith(EVENT_JSON_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(log.slice(EVENT_JSON_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const standard = record["standard"];
  const version = record["version"];
  const event = record["event"];
  if (typeof standard !== "string" || typeof version !== "string" || typeof event !== "string") return null;
  const data = record["data"];
  // Unit variants of the engine's events (`bootstrap_requested`, `bootstrap_failed`) carry no `data`.
  if (standard === ROSE_EVENT_STANDARD && isRoseEventName(event) && data === undefined) {
    return { standard: ROSE_EVENT_STANDARD, version, event: { event, data: {} } as RoseEventView };
  }
  if (standard === ROSE_EVENT_STANDARD && isRoseEventName(event) && typeof data === "object" && data !== null) {
    return { standard: ROSE_EVENT_STANDARD, version, event: { event, data } as RoseEventView };
  }
  if (standard === NEP245_STANDARD && (event === "mt_mint" || event === "mt_burn" || event === "mt_transfer") && Array.isArray(data)) {
    return { standard: NEP245_STANDARD, version, event: { event, data } };
  }
  return { standard, version, event: { event, data } };
}

/** Decodes every NEP-297 event found in `logs`, in order. */
export function decodeEventLogs(logs: readonly string[]): DecodedEvent[] {
  return logs.map(decodeEventLog).filter((event): event is DecodedEvent => event !== null);
}

/** The engine's own events among `logs`. */
export function roseEvents(logs: readonly string[]): RoseEventView[] {
  return decodeEventLogs(logs).flatMap((decoded) => (decoded.standard === ROSE_EVENT_STANDARD ? [decoded.event as RoseEventView] : []));
}

/** The NEP-245 events among `logs`. */
export function nep245Events(logs: readonly string[]): Nep245Event[] {
  return decodeEventLogs(logs).flatMap((decoded) => (decoded.standard === NEP245_STANDARD ? [decoded.event as Nep245Event] : []));
}

/** Formats the raw integer amounts of an event; the defaults print them as stored on chain. */
export interface EventAmountFormat {
  /** Cash amounts and prices (USDC, 6 decimals in every venue rose accepts). */
  cash: (amount: string) => string;
  /** Units of a class (and the tokens they claim). */
  units: (amount: string, classId: string) => string;
  /** NEP-145 storage amounts (yoctoNEAR on chain); printed raw with their unit when absent. */
  near?: (amount: string) => string;
}

const RAW_AMOUNTS: EventAmountFormat = { cash: (amount) => amount, units: (amount) => amount };

function rawYocto(amount: string): string {
  return `${amount} yoctoNEAR`;
}

/** A short, human-readable line for an engine event (activity feed and toasts). */
export function describeRoseEvent(event: RoseEventView, format: EventAmountFormat = RAW_AMOUNTS): string {
  const { cash, units } = format;
  const near = format.near ?? rawYocto;
  switch (event.event) {
    case "class_created": {
      const d = event.data;
      return `Class ${short(d.class_id)} created`;
    }
    case "position_registered": {
      const d = event.data;
      return `Position #${d.position_id} registered by ${d.depositor} (${units(d.allocation, d.class_id)} units)`;
    }
    case "position_released": {
      const d = event.data;
      return `Position #${d.position_id} released to ${d.account}`;
    }
    case "units_minted": {
      const d = event.data;
      return `${units(d.units, d.class_id)} units of ${short(d.class_id)} minted to ${d.account}`;
    }
    case "units_burned": {
      const d = event.data;
      return `${units(d.units, d.class_id)} units of ${short(d.class_id)} burned from ${d.account}`;
    }
    case "units_transferred": {
      const d = event.data;
      return `${units(d.units, d.class_id)} units of ${short(d.class_id)} moved from ${d.from} to ${d.to}`;
    }
    case "cash_deposited": {
      const d = event.data;
      return `${d.account} deposited ${cash(d.amount)} cash on ${venueLabel(d.venue)}`;
    }
    case "cash_withdrawn": {
      const d = event.data;
      return `${d.account} withdrew ${cash(d.amount)} cash on ${venueLabel(d.venue)}`;
    }
    case "cash_withdrawal_failed": {
      const d = event.data;
      return `Cash withdrawal of ${cash(d.amount)} by ${d.account} failed and was re-credited`;
    }
    case "round_created": {
      const d = event.data;
      return `${d.kind} round #${d.round_id} created by ${d.creator}`;
    }
    case "bid_placed": {
      const d = event.data;
      return `Sealed ${d.side === "Buy" ? "bid" : "ask"} #${String(d.bid_id)} placed in round #${d.round_id}`;
    }
    case "round_cancelled": {
      const d = event.data;
      return `Round #${d.round_id} cancelled (${d.reason})`;
    }
    case "key_requested": {
      const d = event.data;
      return `Round #${d.round_id} closed, key requested from the MPC`;
    }
    case "key_request_failed": {
      const d = event.data;
      return `Key request for round #${d.round_id} failed, retry close`;
    }
    case "key_ignored": {
      const d = event.data;
      return `Late key for round #${d.round_id} ignored`;
    }
    case "clearing_failed": {
      const d = event.data;
      return `Clearing of round #${d.round_id} failed: ${d.error}`;
    }
    case "storage_deposited": {
      const d = event.data;
      return `${d.account} deposited ${near(d.amount)} of storage`;
    }
    case "storage_withdrawn": {
      const d = event.data;
      return `${d.account} withdrew ${near(d.amount)} of storage`;
    }
    case "storage_unregistered": {
      const d = event.data;
      return `${d.account} unregistered (${near(d.refund)} refunded)`;
    }
    case "key_received": {
      const d = event.data;
      return `Round key for #${d.round_id} released (${d.source})`;
    }
    case "bid_opened": {
      const d = event.data;
      return d.void ? `Order #${String(d.bid_id)} of round #${d.round_id} opened and void (${d.void})` : `Order #${String(d.bid_id)} of round #${d.round_id} opened`;
    }
    case "round_cleared": {
      const d = event.data;
      return `Round #${d.round_id} cleared at ${cash(d.price)} per locked token`;
    }
    case "bid_settled": {
      const d = event.data;
      return `Order #${String(d.bid_id)} of round #${d.round_id} settled for ${d.bidder}`;
    }
    case "lien_created": {
      const d = event.data;
      return `Lien #${d.lien_id} on ${units(d.units, d.class_id)} units of ${d.holder} (claim ${units(d.claim_total, d.class_id)})`;
    }
    case "lien_released": {
      const d = event.data;
      return `Lien #${d.lien_id} released, the encumbered units are back with ${d.holder}`;
    }
    case "claimable_taken": {
      const d = event.data;
      return `${units(d.amount, d.class_id)} claimed from ${d.source} (${short(d.class_id)})`;
    }
    case "bootstrap_requested":
      return "Engine bootstrap requested (MPC-derived foreign addresses)";
    case "bootstrapped": {
      const d = event.data;
      return `Engine bootstrapped: Base vault ${d.vault_base}, Solana vault ${d.vault_sol}`;
    }
    case "bootstrap_failed":
      return "Engine bootstrap failed, retry bootstrap";
    case "deposit_verification_requested":
      return `Deposit ${replayKeyLabel(event.data.key)} sent to the MPC for verification`;
    case "deposit_verification_failed":
      return `Verification of deposit ${replayKeyLabel(event.data.key)} failed, retry`;
    case "deposit_mismatch":
      return `Deposit ${replayKeyLabel(event.data.key)} does not match its attestation`;
    case "deposit_refused": {
      const d = event.data;
      return `Deposit ${replayKeyLabel(d.key)} refused (${d.reason})`;
    }
    case "deposit_registered": {
      const d = event.data;
      return `${d.chain} position #${d.position_id} registered: ${units(d.units, d.class_id)} units of ${short(d.class_id)} to ${d.account}`;
    }
    case "base_cash_registered": {
      const d = event.data;
      return `${cash(d.amount)} Base cash registered for ${d.account}${d.accepted ? "" : " (token not accepted)"}`;
    }
    case "sol_deposit_attributed": {
      const d = event.data;
      return `Solana stream ${d.metadata.slice(0, 8)}… attributed to ${d.account}`;
    }
    case "payout_requested": {
      const d = event.data;
      return `${d.chain} payout #${d.payout_id} requested by ${d.requester}`;
    }
    case "payout_signed":
      return `Payout #${event.data.payout_id} signed by the MPC`;
    case "payout_awaiting_gas_signature":
      return `Payout #${event.data.payout_id} awaiting its gas signature`;
    case "payout_failed": {
      const d = event.data;
      return `Payout #${d.payout_id} failed (${d.reason})`;
    }
    case "payout_landed":
      return `Payout #${event.data.payout_id} landed on Solana`;
    case "payout_cancelling":
      return `Payout #${event.data.payout_id} is being cancelled on Solana (its signature failed)`;
    case "position_release_requested": {
      const d = event.data;
      return `Position #${d.position_id} release requested by ${d.account} (payout #${d.payout_id})`;
    }
  }
}

function replayKeyLabel(key: ReplayKey): string {
  if ("BaseLog" in key) return `${key.BaseLog.tx_hash.slice(0, 10)}…#${String(key.BaseLog.log_index)}`;
  if ("SolStream" in key) return `${key.SolStream.metadata.slice(0, 8)}…`;
  return `nonce ${key.SolNonce.account.slice(0, 8)}…`;
}

function short(classId: string): string {
  return classId.length > 12 ? `${classId.slice(0, 8)}…` : classId;
}

function venueLabel(venue: Venue): string {
  return venue === "Near" ? "NEAR" : `Base ${venue.Base.token.slice(0, 10)}…`;
}
