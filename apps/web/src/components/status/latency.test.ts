import { describe, expect, it } from "vitest";
import type { StoredEvent } from "./events";
import { formatLatency, KEY_RELEASE, pairLatencies } from "./latency";

let seq = 0;

function event(name: string, secondsSinceEpoch: number, data: Record<string, unknown>): StoredEvent {
  seq += 1;
  return {
    seq: String(seq),
    block_height: String(1_000 + seq),
    timestamp: (BigInt(Math.round(secondsSinceEpoch * 1_000)) * 1_000_000n).toString(),
    predecessor: "alice.testnet",
    event: name,
    data,
  };
}

describe("pairLatencies", () => {
  it("measures each key release from its request, including retries after a failed callback", () => {
    const history = [
      event("round_created", 100, { round_id: "1" }),
      event("key_requested", 100, { round_id: "1" }),
      event("key_received", 104.6, { round_id: "1", source: "Callback", key: "bls12381g1:abc" }),
      event("key_requested", 200, { round_id: "2" }),
      event("key_request_failed", 203, { round_id: "2" }),
      event("key_requested", 210, { round_id: "2" }),
      event("key_received", 215, { round_id: "2", source: "Submitted", key: "bls12381g1:def" }),
      event("key_requested", 300, { round_id: "3" }),
    ];
    const report = pairLatencies(history, KEY_RELEASE);
    expect(report.samples.map((sample) => [sample.key, sample.latencyMs, sample.source])).toEqual([
      ["1", 4_600, "Callback"],
      ["2", 15_000, "Submitted"],
    ]);
    expect(report.pending).toEqual([{ key: "3", requestedAt: 300_000, block: "1008", failures: 0 }]);
    expect(report.failed).toBe(1);
    expect(report.stats).toEqual({ count: 2, medianMs: 4_600, p90Ms: 15_000, minMs: 4_600, maxMs: 15_000 });
  });

  it("ignores completions without a request and returns null stats when nothing completed", () => {
    const report = pairLatencies([event("key_received", 10, { round_id: "9", source: "Callback" })], KEY_RELEASE);
    expect(report.samples).toEqual([]);
    expect(report.stats).toBeNull();
  });

  it("computes the percentiles over the sorted samples", () => {
    const history: StoredEvent[] = [];
    for (let round = 1; round <= 10; round += 1) {
      history.push(event("key_requested", round * 100, { round_id: String(round) }));
      history.push(event("key_received", round * 100 + round, { round_id: String(round), source: "Callback" }));
    }
    const { stats } = pairLatencies(history, KEY_RELEASE);
    expect(stats).toEqual({ count: 10, medianMs: 5_000, p90Ms: 9_000, minMs: 1_000, maxMs: 10_000 });
  });
});

describe("formatLatency", () => {
  it("picks the unit by magnitude", () => {
    expect(formatLatency(820)).toBe("820 ms");
    expect(formatLatency(4_640)).toBe("4.6 s");
    expect(formatLatency(125_000)).toBe("2 min 05 s");
  });
});
