/**
 * The TypeScript Sablier port against live reads, not only against the Rust port's own output:
 * the twelve Lockup Linear streams of `contracts/engine/tests/vectors/sablier_live.json` (Base
 * Sepolia Lockup v4 `streamedAmountOf` at one pinned block, commands inside the file), read from
 * the engine crate directly like the other vectors.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SablierLinearStream } from "../src/unlock.js";

interface LiveStream {
  stream_id: number;
  start: number;
  cliff: number;
  end: number;
  granularity: number;
  start_unlock: string;
  cliff_unlock: string;
  deposited: string;
  streamed: string;
}

const live = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../contracts/engine/tests/vectors/sablier_live.json"), "utf8")) as {
  timestamp: number;
  streams: LiveStream[];
};

describe("SablierLinearStream against live streamedAmountOf", () => {
  it("covers the twelve recorded streams", () => {
    expect(live.streams).toHaveLength(12);
  });

  it.each(live.streams.map((stream) => [stream.stream_id, stream] as const))("reproduces stream %i at the pinned block", (_, stream) => {
    const port = new SablierLinearStream({
      start: BigInt(stream.start),
      cliff: BigInt(stream.cliff),
      end: BigInt(stream.end),
      granularity: BigInt(stream.granularity),
      startUnlock: BigInt(stream.start_unlock),
      cliffUnlock: BigInt(stream.cliff_unlock),
      deposited: BigInt(stream.deposited),
    });
    expect(port.streamedAmount(BigInt(live.timestamp))).toBe(BigInt(stream.streamed));
  });
});
