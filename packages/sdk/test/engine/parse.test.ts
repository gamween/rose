import { describe, expect, it } from "vitest";
import { EngineParseError, parseClass, parseEventsPage, parseLimits, parsePortfolio, parseRound, parseStats } from "../../src/engine/parse.js";
import { CLASS_ID, classView, eventsPageView, limitsView, portfolioView, roundView, statsView } from "./fixtures.js";

describe("engine view parsing", () => {
  it("parses stats with a bigint volume", () => {
    expect(parseStats(statsView)).toEqual({ roundsTotal: 3, roundsSettled: 2, volumeSettledUsdc: 125000000000n, classes: 3, positions: 6 });
  });

  it("rejects a non-integer U128", () => {
    expect(() => parseStats({ ...statsView, volume_settled_usdc: "12.5" })).toThrow(EngineParseError);
    expect(() => parseStats({ ...statsView, classes: -1 })).toThrow(EngineParseError);
  });

  it("parses a class with its linear schedule", () => {
    const parsed = parseClass(classView);
    expect(parsed.classId).toBe(CLASS_ID);
    expect(parsed.decimals).toBe(18);
    expect(parsed.schedule).toEqual({
      kind: "Linear",
      start: 1793750000n,
      cliff: 1796342000n,
      end: 1825286000n,
      granularity: 1n,
      total: 1000000000000000000000000n,
      startUnlock: 0n,
      cliffUnlock: 100000000000000000000000n,
      minDeposit: 1000000000000000000n,
    });
    expect(parsed.fractionNow).toBe(123456789012345678n);
  });

  it("parses the limits with the round window bounds", () => {
    const limits = parseLimits(limitsView);
    expect(limits.minKeyTimeout).toBe(60_000_000_000n);
    expect(limits.maxKeyTimeout).toBe(604_800_000_000_000n);
    expect(limits.minRevealWindow).toBe(300_000_000_000n);
    expect(limits.maxRevealWindow).toBe(604_800_000_000_000n);
    expect(limits.maxRoundHorizon).toBe(2_592_000_000_000_000n);
    expect(() => parseLimits({ ...limitsView, min_key_timeout: "-1" })).toThrow(EngineParseError);
  });

  it("parses the largest buy quantity of an Exit round", () => {
    expect(parseRound(roundView).maxBuyQuantity).toBeNull();
    expect(parseRound({ ...roundView, kind: "Exit", max_buy_quantity: "2000000" }).maxBuyQuantity).toBe(2_000_000n);
  });

  it("parses a settled tender round with its result and fills", () => {
    const round = parseRound(roundView);
    expect(round.roundId).toBe(7n);
    expect(round.venue).toEqual({ Base: { token: "0xf8f5a4c21d80993fa2fc9fe649f95384ab6dec57" } });
    expect(round.budget).toBe(950000000n);
    expect(round.issuerEscrow).toBe(953000000n);
    expect(round.advanceUnits).toBeNull();
    expect(round.keySource).toBe("Callback");
    expect(round.result?.price).toBe(9000000n);
    expect(round.result?.issuerRefund).toBe(50000000n);
    expect(round.result?.fills[0]?.opened).toEqual({ quantity: 100000000000000000000n, price: 9000000n });
    expect(round.result?.fills[1]?.void).toBe("Unopened");
    expect(round.result?.fills[1]?.opened).toBeNull();
  });

  it("parses a portfolio: holdings, bids, liens, shares and cash per venue", () => {
    const portfolio = parsePortfolio(portfolioView);
    expect(portfolio.holdings[0]?.claimable).toBe(12500000000000000000n);
    expect(portfolio.bids[0]?.ciphertextHex).toHaveLength(384);
    expect(portfolio.bids[0]?.placedAt).toBe(1793761000000000000n);
    expect(portfolio.liensHeld[0]?.claimTotal).toBe(5000000000000000000n);
    expect(portfolio.lienShares[0]?.funder).toBe("varick.testnet");
    expect(portfolio.cash).toEqual([
      { venue: "Near", amount: 250000000n },
      { venue: { Base: { token: "0xf8f5a4c21d80993fa2fc9fe649f95384ab6dec57" } }, amount: 100000000n },
    ]);
  });

  it("parses an events page keeping the flattened event discriminant", () => {
    const page = parseEventsPage(eventsPageView);
    expect(page.total).toBe(43n);
    expect(page.events).toHaveLength(3);
    const cleared = page.events[2];
    expect(cleared?.seq).toBe(42n);
    expect(cleared?.predecessor).toBe("anyone.testnet");
    expect(cleared?.event.event).toBe("round_cleared");
    if (cleared?.event.event === "round_cleared") expect(cleared.event.data.price).toBe("9000000");
  });
});
