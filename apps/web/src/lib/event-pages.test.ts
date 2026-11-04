import { describe, expect, it } from "vitest";
import { readEventRange, type EventPage } from "./event-pages";

/** A history of `total` events where `bad` seqs cannot be deserialized, as the staging engine-s3 behaves. */
function history(total: number, bad: readonly number[]) {
  const reads: string[] = [];
  const read = async (from: bigint, limit: number): Promise<EventPage<number>> => {
    reads.push(`${String(from)}+${String(limit)}`);
    const seqs = Array.from({ length: limit }, (_, index) => Number(from) + index).filter((seq) => seq < total);
    if (seqs.some((seq) => bad.includes(seq))) throw new Error("wasm execution failed with error: HostError(GuestPanic { panic_msg: \"Cannot deserialize element\" })");
    return { events: seqs, total: BigInt(total), oldest: 0n };
  };
  return { read, reads };
}

describe("readEventRange", () => {
  it("reads a healthy range in one call", async () => {
    const { read, reads } = history(59, []);
    const range = await readEventRange(read, 0n, 40);
    expect(range.events).toHaveLength(40);
    expect(range.skipped).toEqual([]);
    expect(reads).toEqual(["0+40"]);
  });

  it("skips only the entry the engine cannot deserialize", async () => {
    const { read } = history(59, [19]);
    const range = await readEventRange(read, 0n, 40);
    expect(range.events).toEqual(Array.from({ length: 40 }, (_, index) => index).filter((seq) => seq !== 19));
    expect(range.skipped).toEqual([19n]);
    expect(range.total).toBe(59n);
  });

  it("rethrows any other failure", async () => {
    const read = () => Promise.reject(new Error("NEAR RPC unreachable"));
    await expect(readEventRange(read, 0n, 10)).rejects.toThrow("unreachable");
  });
});
