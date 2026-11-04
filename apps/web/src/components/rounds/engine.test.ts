import type { Round, RoundFilter } from "@rose/sdk";
import { describe, expect, it, vi } from "vitest";
import { fetchNewestRounds } from "./engine";

/** An engine whose `get_rounds` follows views.rs: scan ids upwards from `from`, stop at `limit` matches or 200 ids. */
function engine(ids: number[], match: (id: number) => boolean = () => true) {
  const getRounds = vi.fn(async (_filter: RoundFilter | undefined, from: bigint | number | undefined, limit = 20) => {
    const start = Number(from ?? 0);
    const rounds: Round[] = [];
    let next: bigint | null = null;
    const end = Math.min(Math.max(...ids) + 1, start + 200);
    for (let id = start; id < end; id += 1) {
      if (rounds.length === limit) {
        next = BigInt(id);
        break;
      }
      if (ids.includes(id) && match(id)) rounds.push({ roundId: BigInt(id) } as Round);
    }
    return { rounds, next };
  });
  return { views: { getRounds } as never, getRounds };
}

const ids = (rounds: readonly Round[]) => rounds.map((round) => Number(round.roundId));

describe("rounds list, newest first", () => {
  it("reads the newest page first and continues below it", async () => {
    const all = Array.from({ length: 21 }, (_, id) => id);
    const fake = engine(all);
    const first = await fetchNewestRounds(fake, {}, 21n);
    expect(ids(first.rounds)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9]);
    expect(first.next).toBe(9n);
    const second = await fetchNewestRounds(fake, {}, 9n);
    expect(ids(second.rounds)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(second.next).toBeNull();
  });

  it("drops matches above the window and scans wider windows for a sparse filter", async () => {
    const all = Array.from({ length: 130 }, (_, id) => id);
    const fake = engine(all, (id) => id % 40 === 0);
    const page = await fetchNewestRounds(fake, { kind: "Tender" }, 130n);
    expect(ids(page.rounds)).toEqual([120, 80, 40, 0]);
    expect(page.next).toBeNull();
    expect(fake.getRounds.mock.calls.map((call) => Number(call[1]))).toEqual([80, 30, 0]);
  });

  it("returns nothing for an engine without rounds", async () => {
    await expect(fetchNewestRounds(engine([0]), {}, 0n)).resolves.toEqual({ rounds: [], next: null });
  });
});
