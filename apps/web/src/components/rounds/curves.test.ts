import { ONE, type Bid, type Order } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { buildBook, priceTickLabel, roundCurves, tenderCurves, uniformCurves } from "./curves";

const U = (n: number) => BigInt(n) * 1_000_000n;

function bid(bidId: number, side: "Buy" | "Sell", opened: { quantity: bigint; price: bigint } | null, extra: Partial<Bid> = {}): Bid {
  return {
    roundId: 1n,
    bidId,
    bidder: `b${String(bidId)}.testnet`,
    side,
    status: opened ? "Opened" : "Sealed",
    escrow: side === "Buy" ? U(100) : 0n,
    lockedUnits: side === "Sell" ? (opened?.quantity ?? U(10)) : 0n,
    bond: U(1),
    fee: 0n,
    cash: 0n,
    fillQuantity: 0n,
    ciphertextHex: "ab".repeat(192),
    placedAt: null,
    opened,
    void: null,
    ...extra,
  };
}

describe("buildBook", () => {
  it("keeps opened, non-void orders at or under the max price and counts the rest", () => {
    const bids = [
      bid(0, "Buy", { quantity: U(10), price: U(10) }),
      bid(1, "Buy", { quantity: U(5), price: U(8) }),
      bid(2, "Sell", { quantity: U(10), price: U(6) }),
      bid(3, "Buy", null),
      bid(4, "Buy", { quantity: U(1), price: U(2) }, { void: "EscrowTooSmall" }),
      bid(5, "Buy", { quantity: U(1), price: U(11) }),
    ];
    const book = buildBook({ maxPrice: U(10) }, bids);
    expect(book.bids.map((o) => Number(o.id))).toEqual([0, 1]);
    expect(book.asks.map((o) => Number(o.id))).toEqual([2]);
    expect(book.unopened).toBe(1);
    expect(book.excluded).toEqual([
      { bidId: 4, reason: "EscrowTooSmall" },
      { bidId: 5, reason: "AboveMaxPrice" },
    ]);
  });
});

describe("uniformCurves (spec 5.4 Exit)", () => {
  const bids: Order[] = [
    { id: 0n, qty: U(10), price: U(10) },
    { id: 1n, qty: U(5), price: U(8) },
  ];
  const asks: Order[] = [{ id: 2n, qty: U(10), price: U(6) }];

  it("reproduces the intervals of clearing example 3", () => {
    const curves = uniformCurves(bids, asks, U(12));
    const at = (price: bigint) => curves.steps.find((s) => price >= s.from && price < s.to);
    expect(at(U(3))).toMatchObject({ demand: U(15), supply: 0n });
    expect(at(U(7))).toMatchObject({ demand: U(15), supply: U(10) });
    expect(at(U(9))).toMatchObject({ demand: U(10), supply: U(10) });
    expect(at(U(11))).toMatchObject({ demand: 0n, supply: U(10) });
    expect(curves.maxQty).toBe(U(15));
    expect(curves.prices).toEqual([U(6), U(8), U(10)]);
  });

  it("demand drops one tick above a limit and supply rises at a minimum", () => {
    const curves = uniformCurves(bids, asks, U(12));
    const froms = curves.steps.map((s) => s.from);
    expect(froms).toContain(U(8) + 1n);
    expect(froms).toContain(U(10) + 1n);
    expect(froms).toContain(U(6));
    const last = curves.steps[curves.steps.length - 1];
    expect(last?.to).toBe(U(12));
  });

  it("handles an empty book", () => {
    const curves = uniformCurves([], [], U(5));
    expect(curves.steps).toHaveLength(1);
    expect(curves.maxQty).toBe(0n);
  });
});

describe("tenderCurves (spec 5.4 Tender)", () => {
  it("caps the affordable curve and reproduces Q(P) of example 1 (whole units, 0 decimals)", () => {
    const asks: Order[] = [
      { id: 0n, qty: 100n, price: U(9) },
      { id: 1n, qty: 10n, price: U(10) },
    ];
    const curves = tenderCurves(asks, U(950), { lockedFractionE18: ONE, tokenDecimals: 0 }, U(12), 12);
    const at = (price: bigint) => curves.steps.find((s) => price >= s.from && price < s.to);
    expect(at(U(9))).toMatchObject({ supply: 100n, demand: 105n });
    expect(at(U(10))).toMatchObject({ supply: 110n, demand: 95n });
    const first = curves.steps[0];
    expect(first?.demand).toBe(330n);
  });
});

describe("roundCurves", () => {
  it("extends the axis a sixth past the highest order and picks the tender shape", () => {
    const book = buildBook({ maxPrice: U(10) }, [bid(0, "Sell", { quantity: U(100), price: U(9) })]);
    const curves = roundCurves({ kind: "Tender", fTs: 0n, maxPrice: U(10), budget: U(950) }, 6, book);
    expect(curves.maxPrice).toBe(U(9) + U(9) / 6n + 1n);
    expect(curves.steps.length).toBeGreaterThan(10);
    const empty = roundCurves({ kind: "Exit", fTs: 0n, maxPrice: U(10), budget: null }, 6, buildBook({ maxPrice: U(10) }, []));
    expect(empty.maxPrice).toBe(U(10));
  });
});

describe("price axis labels", () => {
  it("prints enough decimals for the tick step, so no two ticks read the same (engine-s4 round 5 axis)", () => {
    const labels = [0, 0.005, 0.01, 0.015, 0.02].map((tick) => priceTickLabel(tick, 0.005));
    expect(labels).toEqual(["0.000", "0.005", "0.010", "0.015", "0.020"]);
    expect(priceTickLabel(0.4, 0.2)).toBe("0.40");
    expect(priceTickLabel(0.02, 0.01)).toBe("0.02");
    expect(priceTickLabel(6, 2)).toBe("6");
    expect(priceTickLabel(2500, 500)).toBe("2.5k");
  });
});
