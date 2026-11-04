/**
 * Which entries of the engine's on-chain history (`get_events`) belong to each step of a demo
 * scenario. Round events carry the round id; deposits, cash and payouts are matched through the
 * scenario's positions, participants and the accounts its transactions name, so the walkthrough
 * shows the engine's own record of every step next to its transactions.
 */

import type { DemoManifest, DemoScenario } from "./manifest";
import type { WalkStep } from "./walkthrough";

/** The fields of a stored event the matcher reads (`StoredEvent` of `@rose/sdk`). */
export interface HistoryEvent {
  seq: bigint;
  event: { event: string; data?: unknown };
}

type Data = Record<string, unknown>;

function dataOf(entry: HistoryEvent): Data {
  const data = entry.event.data;
  return typeof data === "object" && data !== null ? (data as Data) : {};
}

function field(entry: HistoryEvent, key: string): string | null {
  const value = dataOf(entry)[key];
  return typeof value === "string" ? value : null;
}

/** Accounts of the cast that a step's transaction labels name. */
export function actorsOf(manifest: DemoManifest, step: Pick<WalkStep, "txs">): string[] {
  const out = new Set<string>();
  for (const tx of step.txs) {
    for (const person of manifest.people) {
      if (tx.label.includes(person.name) || tx.label.includes(person.account)) out.add(person.account);
    }
  }
  return [...out];
}

function participants(scenario: DemoScenario): Set<string> {
  return new Set([scenario.creator, ...scenario.orders.map((order) => order.account)]);
}

function lastSeq(events: readonly HistoryEvent[], roundId: string, name: string): bigint | null {
  let last: bigint | null = null;
  for (const entry of events) {
    if (entry.event.event === name && field(entry, "round_id") === roundId) last = entry.seq;
  }
  return last;
}

/**
 * The history entries of `step`, in order. `venueIsNear` is the live round's cash venue: cash
 * events of the other venue belong to other rounds.
 */
export function stepEvents<E extends HistoryEvent>(manifest: DemoManifest, scenario: DemoScenario, step: WalkStep, events: readonly E[], venueIsNear: boolean): E[] {
  const cls = manifest.classes.find((candidate) => candidate.key === scenario.classKey);
  const classId = cls?.classId ?? "";
  const positionIds = new Set(scenario.positions.map((position) => position.positionId));
  const holders = new Set(scenario.positions.map((position) => position.account));
  const people = participants(scenario);
  const actors = new Set(actorsOf(manifest, step));
  const named = new Set(step.events);
  const settledAt = lastSeq(events, scenario.roundId, "bid_settled");

  switch (step.id) {
    case "deposit":
      return events.filter((entry) => {
        const name = entry.event.event;
        if (name === "deposit_registered" || name === "position_registered") return positionIds.has(field(entry, "position_id") ?? "");
        if (name === "sol_deposit_attributed") return field(entry, "class_id") === classId && holders.has(field(entry, "account") ?? "");
        return false;
      });
    case "cash":
      return events.filter((entry) => {
        const name = entry.event.event;
        if (!people.has(field(entry, "account") ?? "")) return false;
        if (name === "base_cash_registered") return !venueIsNear;
        if (name === "cash_deposited") return (dataOf(entry).venue === "Near") === venueIsNear;
        return false;
      });
    case "payout": {
      if (settledAt === null) return [];
      const after = events.filter((entry) => entry.seq > settledAt);
      const payouts = new Set(after.filter((entry) => entry.event.event === "payout_requested" && actors.has(field(entry, "requester") ?? "")).map((entry) => field(entry, "payout_id")));
      return after.filter((entry) => {
        const name = entry.event.event;
        if (name === "payout_requested" || name === "payout_signed") return payouts.has(field(entry, "payout_id"));
        if (name === "cash_withdrawn") return actors.has(field(entry, "account") ?? "");
        if (name === "claimable_taken") return field(entry, "class_id") === classId && scenario.kind === "Advance";
        return false;
      });
    }
    case "redeem": {
      const released = new Set(events.filter((entry) => entry.event.event === "position_release_requested" && positionIds.has(field(entry, "position_id") ?? "")).map((entry) => field(entry, "payout_id")));
      return events.filter((entry) => {
        const name = entry.event.event;
        if (name === "position_release_requested" || name === "position_released") return positionIds.has(field(entry, "position_id") ?? "");
        if (name === "payout_signed") return released.has(field(entry, "payout_id"));
        if (name === "units_burned") return field(entry, "class_id") === classId && actors.has(field(entry, "account") ?? "") && settledAt !== null && entry.seq > settledAt;
        return false;
      });
    }
    default:
      return events.filter((entry) => named.has(entry.event.event) && field(entry, "round_id") === scenario.roundId);
  }
}
