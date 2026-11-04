import { describe, expect, it, vi } from "vitest";

const viewCall = vi.fn();
vi.mock("@/lib/engine", () => ({ viewCall: (...args: unknown[]) => viewCall(...args) }));

const { fetchPriceHistory } = await import("./data");

function point(round: number) {
  return { round_id: round, kind: "Exit", price: "25000", remaining_lock_secs: "1", volume: "1", settled_at: "1" };
}

describe("price history reads", () => {
  it("pages get_price_history until its total, the engine returns at most 50 points per call", async () => {
    const total = 120;
    viewCall.mockImplementation(async (_account: string, _method: string, args: { from_index: number; limit: number }) => ({
      value: { points: Array.from({ length: Math.max(0, Math.min(args.limit, total - args.from_index)) }, (_, i) => point(args.from_index + i)), total },
      blockHeight: 1,
    }));
    const points = await fetchPriceHistory("engine.testnet", "a".repeat(64), {});
    expect(points).toHaveLength(120);
    expect(points[119]?.round_id).toBe(119);
    expect(viewCall.mock.calls.map((call) => (call[2] as { from_index: number }).from_index)).toEqual([0, 50, 100]);
  });
});
