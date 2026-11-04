import { viewCall, type ViewOptions } from "@/lib/engine";
import { readEventRange } from "@/lib/event-pages";

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

/** A stored event, with `data` set to `{}` for the unit variants the engine serializes without it (`bootstrap_requested`). */
function toStoredEvent(value: unknown): StoredEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.seq !== "string" || typeof event.timestamp !== "string" || typeof event.block_height !== "string" || typeof event.event !== "string") return null;
  if (event.data !== undefined && (typeof event.data !== "object" || event.data === null)) return null;
  return { ...(event as Omit<StoredEvent, "data">), data: (event.data as Record<string, unknown> | undefined) ?? {} };
}

export function parsePage(raw: unknown): EventsPage {
  if (typeof raw !== "object" || raw === null) throw new Error("get_events did not return an object.");
  const page = raw as Partial<Record<keyof EventsPage, unknown>>;
  const events = Array.isArray(page.events) ? page.events.map(toStoredEvent) : null;
  if (events === null || events.some((event) => event === null)) throw new Error("get_events returned malformed events.");
  if (typeof page.total !== "string" || typeof page.oldest !== "string") throw new Error("get_events returned no counters.");
  return { events: events as StoredEvent[], total: page.total, oldest: page.oldest };
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
    const range = await readEventRange(
      async (fromSeq, limit) => {
        const page = await viewCall<unknown>(account, "get_events", { from_seq: fromSeq.toString(), limit }, options);
        blockHeight = page.blockHeight;
        const parsed = parsePage(page.value);
        return { events: parsed.events, total: BigInt(parsed.total), oldest: BigInt(parsed.oldest) };
      },
      from,
      PAGE,
    );
    if (range.events.length === 0 && range.skipped.length === 0) break;
    events.push(...range.events);
    from += BigInt(PAGE);
  }
  return { events, total, oldest, blockHeight };
}

/** Converts a nanosecond block timestamp to milliseconds since the epoch. */
export function nanosToMillis(timestamp: string): number {
  return Number(BigInt(timestamp) / 1_000_000n);
}
