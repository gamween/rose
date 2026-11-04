/**
 * Reads a range of the engine's on-chain event history while skipping single entries the
 * engine cannot deserialize. A contract redeployed with a reordered `RoseEvent` enum (seen on the
 * staging engine `engine-s3.rose-app.testnet`, seq 19, "Cannot deserialize element") makes every
 * `get_events` page containing such an entry panic; bisecting isolates it in about 2 log2(limit)
 * extra reads instead of losing the whole page.
 */

export type EventPage<E> = { events: E[]; total: bigint; oldest: bigint };

export type EventRange<E> = EventPage<E> & { skipped: bigint[] };

const UNREADABLE = /Cannot deserialize/;

function unreadable(error: unknown): boolean {
  return error instanceof Error && UNREADABLE.test(error.message);
}

/** The events with seq in `[from, from + limit)`, every readable one, in order. */
export async function readEventRange<E>(read: (fromSeq: bigint, limit: number) => Promise<EventPage<E>>, from: bigint, limit: number): Promise<EventRange<E>> {
  try {
    const page = await read(from, limit);
    return { ...page, skipped: [] };
  } catch (error) {
    if (!unreadable(error)) throw error;
    if (limit <= 1) return { events: [], total: from + 1n, oldest: 0n, skipped: [from] };
    const half = Math.floor(limit / 2);
    const left = await readEventRange(read, from, half);
    const right = await readEventRange(read, from + BigInt(half), limit - half);
    return {
      events: [...left.events, ...right.events],
      total: left.total > right.total ? left.total : right.total,
      oldest: left.oldest < right.oldest ? left.oldest : right.oldest,
      skipped: [...left.skipped, ...right.skipped],
    };
  }
}
