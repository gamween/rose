import { viewCall, type ViewOptions } from "@/lib/engine";

/** One entry of the engine's on-chain event history (`get_events`), as returned by the view. */
export type StoredEvent = {
  seq: string;
  block_height: string;
  /** Block timestamp, nanoseconds, as a decimal string. */
  timestamp: string;
  predecessor: string;
  event: string;
  data: Record<string, unknown>;
};

export type EventsPage = { events: StoredEvent[]; total: string; oldest: string };

export type EventHistory = { events: StoredEvent[]; total: bigint; oldest: bigint; blockHeight: number };

const PAGE = 200;

function isStoredEvent(value: unknown): value is StoredEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.seq === "string" &&
    typeof event.timestamp === "string" &&
    typeof event.block_height === "string" &&
    typeof event.event === "string" &&
    typeof event.data === "object" &&
    event.data !== null
  );
}

function parsePage(raw: unknown): EventsPage {
  if (typeof raw !== "object" || raw === null) throw new Error("get_events did not return an object.");
  const page = raw as Partial<EventsPage>;
  if (!Array.isArray(page.events) || !page.events.every(isStoredEvent)) throw new Error("get_events returned malformed events.");
  if (typeof page.total !== "string" || typeof page.oldest !== "string") throw new Error("get_events returned no counters.");
  return { events: page.events, total: page.total, oldest: page.oldest };
}

/**
 * Reads the most recent `window` events of the engine history, oldest first, paging through the
 * bounded ring buffer (1,024 entries on chain).
 */
export async function fetchRecentEvents(account: string, window = 600, options: ViewOptions = {}): Promise<EventHistory> {
  const probe = await viewCall<unknown>(account, "get_events", { limit: 1 }, options);
  const first = parsePage(probe.value);
  const total = BigInt(first.total);
  const oldest = BigInt(first.oldest);
  let from = total - BigInt(window);
  if (from < oldest) from = oldest;
  const events: StoredEvent[] = [];
  let blockHeight = probe.blockHeight;
  while (from < total) {
    const page = await viewCall<unknown>(account, "get_events", { from_seq: from.toString(), limit: PAGE }, options);
    const parsed = parsePage(page.value);
    blockHeight = page.blockHeight;
    if (parsed.events.length === 0) break;
    events.push(...parsed.events);
    from = BigInt(parsed.events[parsed.events.length - 1]!.seq) + 1n;
  }
  return { events, total, oldest, blockHeight };
}

/** Converts a nanosecond block timestamp to milliseconds since the epoch. */
export function nanosToMillis(timestamp: string): number {
  return Number(BigInt(timestamp) / 1_000_000n);
}
