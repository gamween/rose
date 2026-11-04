import { EngineCalls, ONE, type Bid, type ClassInfo, type Round, type RoundResult } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { checkRows, parseAllocationLines, rowsTotal, splitBatches } from "./allocations";
import { dateTimeToSeconds, normalizeLinear, normalizeStepped, sablierScheduleArgs, secondsToDateTime, streamflowScheduleArgs } from "./class-schedule";
import { sputnikCliCommand, sputnikProposal, trezuSlug, trezuTemplate, yoctoToNearText } from "./dao";
import { askOrders, candidateTable, eventsOfRound, recompute, tenderReportCsv } from "./report";
import { maxPriceFromDiscount, percentToBps, tenderArgsFromForm, tenderEscrow, validateRetireTo, windowFromInput } from "./tender-form";

const DAY = 86_400n;
const T0 = 1_762_200_000n;

describe("class schedules", () => {
  it("normalizes a Sablier schedule by the gcd of its amounts", () => {
    const schedule = normalizeLinear({ start: T0, cliff: T0 + 30n * DAY, end: T0 + 365n * DAY, granularity: 1n, deposited: 1_000n * 10n ** 18n, startUnlock: 0n, cliffUnlock: 100n * 10n ** 18n }, 18);
    expect(schedule).toMatchObject({ kind: "Linear", total: 10n, cliffUnlock: 1n, startUnlock: 0n, minDeposit: 10n ** 18n, granularity: 1n });
  });
  it("normalizes a Streamflow schedule to its effective start", () => {
    const schedule = normalizeStepped({ startTime: T0, cliff: T0 + 7n * DAY, endTime: T0 + 37n * DAY, period: 3600n, netAmountDeposited: 1_000_000_000n, cliffAmount: 100_000_000n, amountPerPeriod: 1_630_434n });
    expect(schedule.kind).toBe("Stepped");
    expect(schedule.start).toBe(T0 + 7n * DAY);
    expect(schedule.kind === "Stepped" && schedule.period).toBe(3600n);
  });
  it("builds the class id view arguments with u64 numbers and u128 strings", () => {
    const args = sablierScheduleArgs({ start: T0, cliff: 0n, end: T0 + DAY, granularity: 1n, deposited: 5n * 10n ** 18n, startUnlock: 0n, cliffUnlock: 0n });
    expect(args).toEqual({ start: Number(T0), cliff: 0, end: Number(T0 + DAY), granularity: 1, deposited: "5000000000000000000", start_unlock: "0", cliff_unlock: "0" });
    expect(streamflowScheduleArgs({ startTime: T0, cliff: 0n, endTime: T0 + DAY, period: 60n, netAmountDeposited: 10n, cliffAmount: 0n, amountPerPeriod: 1n }).net_amount_deposited).toBe(10);
    expect(() => streamflowScheduleArgs({ startTime: T0, cliff: 0n, endTime: T0 + DAY, period: 60n, netAmountDeposited: 2n ** 60n, cliffAmount: 0n, amountPerPeriod: 1n })).toThrow(/does not fit/);
  });
  it("converts datetime-local text as UTC", () => {
    expect(dateTimeToSeconds("2026-11-04T12:30")).toBe(BigInt(Date.UTC(2026, 10, 4, 12, 30) / 1000));
    expect(dateTimeToSeconds("")).toBeNull();
    expect(secondsToDateTime(dateTimeToSeconds("2026-11-04T12:30")!)).toBe("2026-11-04T12:30");
  });
});

describe("allocations", () => {
  it("parses pasted lines with any separator and skips comments", () => {
    expect(parseAllocationLines("# cohort\nhalden.testnet, 1000\ntessaro.testnet;250.5\n\nines.testnet\t10")).toEqual([
      { account: "halden.testnet", amount: "1000" },
      { account: "tessaro.testnet", amount: "250.5" },
      { account: "ines.testnet", amount: "10" },
    ]);
  });
  it("checks accounts, amounts, duplicates and unit multiples", () => {
    const rows = checkRows(
      [
        { account: "halden.testnet", amount: "1000" },
        { account: "Bad.Account", amount: "1" },
        { account: "halden.testnet", amount: "5" },
        { account: "ines.testnet", amount: "7" },
        { account: "nadia.testnet", amount: "0" },
      ],
      18,
      5n * 10n ** 18n,
    );
    expect(rows.map((row) => row.error)).toEqual([null, "Not a valid NEAR account id.", "Duplicate account.", "Not a multiple of the unit amount.", "The amount must be positive."]);
    expect(rowsTotal(rows)).toBe(1000n * 10n ** 18n);
  });
  it("splits receivers into batches under the engine limit", () => {
    expect(splitBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(splitBatches([], 50)).toEqual([]);
  });
});

describe("tender form", () => {
  it("derives the max price from a declared reference and a discount", () => {
    expect(maxPriceFromDiscount(10_000_000n, 1500)).toBe(8_500_000n);
    expect(maxPriceFromDiscount(10_000_000n, 0)).toBe(10_000_000n);
    expect(percentToBps("15")).toBe(1500);
    expect(percentToBps("12.5")).toBe(1250);
    expect(percentToBps("101")).toBeNull();
    expect(percentToBps("x")).toBeNull();
  });
  it("computes the escrow with the 30 bps fee on the budget", () => {
    expect(tenderEscrow(950_000_000n)).toEqual({ fee: 2_850_000n, escrow: 952_850_000n });
  });
  it("validates retire_to per chain", () => {
    expect(validateRetireTo("Base", "0x000000000000000000000000000000000000dead")).toBeNull();
    expect(validateRetireTo("Base", "1nc1nerator11111111111111111111111111111111")).not.toBeNull();
    expect(validateRetireTo("Solana", "1nc1nerator11111111111111111111111111111111")).toBeNull();
  });
  it("validates the window and converts it to nanoseconds", () => {
    const now = Date.UTC(2026, 10, 4, 12, 0);
    expect(windowFromInput({ opensNow: true, opensAt: "", closesAt: "2026-11-05T12:00" }, now)).toEqual({ opensAt: undefined, closesAt: BigInt(Date.UTC(2026, 10, 5, 12, 0)) * 1_000_000n });
    expect(windowFromInput({ opensNow: true, opensAt: "", closesAt: "2026-11-03T12:00" }, now)).toEqual({ error: "The round must close in the future." });
    expect(windowFromInput({ opensNow: false, opensAt: "2026-11-06T12:00", closesAt: "2026-11-05T12:00" }, now)).toEqual({ error: "The round must close after it opens." });
  });
  it("turns the form into create_tender arguments", () => {
    const now = Date.UTC(2026, 10, 4, 12, 0);
    const result = tenderArgsFromForm(
      { classId: "c", chain: "Base", venue: "Near", budget: 950_000_000n, mode: "discount", maxPrice: null, referencePrice: 10_000_000n, discountBps: 1000, retireTo: "0x000000000000000000000000000000000000DEAD", window: { opensNow: true, opensAt: "", closesAt: "2026-11-05T12:00" } },
      now,
    );
    expect(result).toMatchObject({ args: { maxPrice: 9_000_000n, referencePrice: 10_000_000n, retireTo: "0x000000000000000000000000000000000000dead" } });
    expect(tenderArgsFromForm({ classId: "c", chain: "Base", venue: "Near", budget: 0n, mode: "price", maxPrice: 1n, referencePrice: null, discountBps: null, retireTo: "", window: { opensNow: true, opensAt: "", closesAt: "" } }, now)).toEqual({ error: "Enter a positive budget." });
  });
});

describe("DAO wrappers", () => {
  const calls = new EngineCalls("engine.rose-app.testnet");
  const tenderArgs = { classId: "a".repeat(64), venue: "Near" as const, budget: 950_000_000n, maxPrice: 9_000_000n, referencePrice: 10_000_000n, retireTo: "0x000000000000000000000000000000000000dead", window: { closesAt: 1_762_300_000_000_000_000n } };
  const call = calls.createTender(tenderArgs);

  it("builds the Sputnik v2 add_proposal arguments with base64 args and string deposit and gas", () => {
    const proposal = sputnikProposal(call, "rose Tender");
    const action = proposal.proposal.kind.FunctionCall.actions[0]!;
    expect(proposal.proposal.kind.FunctionCall.receiver_id).toBe("engine.rose-app.testnet");
    expect(action.method_name).toBe("create_tender");
    expect(action.deposit).toBe("50000000000000000000000");
    expect(action.gas).toBe("30000000000000");
    expect(JSON.parse(Buffer.from(action.args, "base64").toString("utf8"))).toEqual(call.args);
  });
  it("writes a near-cli-rs command attaching the exact bond", () => {
    const command = sputnikCliCommand("test.sputnikv2.testnet", sputnikProposal(call, "d"), 10n ** 24n, "cindral.testnet");
    expect(command).toContain("test.sputnikv2.testnet");
    expect(command).toContain("attached-deposit '1 NEAR'");
    expect(command).toContain("sign-as cindral.testnet");
    expect(yoctoToNearText(50_000_000_000_000_000_000_000n)).toBe("0.05 NEAR");
  });
  it("produces a Trezu manifest whose placeholders all reference declared fields", () => {
    const manifest = trezuTemplate({ id: trezuSlug(tenderArgs.classId, "Seed Round"), title: "Tender", engine: "engine.rose-app.testnet", call, tender: tenderArgs, classLabel: "CINDR", venueLabel: "NEAR tUSDC" });
    expect(manifest.id).toBe("rose-tender-seed-round-aaaaaaaa");
    expect(manifest.binding).toEqual({ receiver_id: "engine.rose-app.testnet", method_name: "create_tender", deposit: "50000000000000000000000", gas: "30000000000000" });
    const names = new Set(manifest.fields.map((field) => field.name));
    const placeholders = [...`${JSON.stringify(manifest.args)} ${manifest.summary}`.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((match) => match[1]);
    expect(placeholders.length).toBeGreaterThan(0);
    for (const name of placeholders) expect(names.has(name!), name).toBe(true);
    expect((manifest.args.params as { reference_price: string }).reference_price).toBe("{{reference_price}}");
    expect(manifest.fields.find((field) => field.name === "budget")?.default).toBe("950000000");
  });
});

describe("tender report", () => {
  const cls: ClassInfo = { classId: "c", chain: "Base", token: "0x44", tokenRisk: "", decimals: 18, schedule: { kind: "Linear", start: T0, cliff: 0n, end: T0 + DAY, granularity: 1n, total: 1n, startUnlock: 0n, cliffUnlock: 0n, minDeposit: 10n ** 18n }, totalUnits: 0n, positions: 0, createdAt: 0n, fractionNow: 0n };
  const round: Round = {
    roundId: 7n, kind: "Tender", classId: "c", venue: "Near", creator: "cindral.testnet", status: "Settled", appId: "", opensAt: T0 * 1_000_000_000n, closesAt: (T0 + DAY) * 1_000_000_000n, keyTimeout: 0n, revealWindow: 0n,
    maxPrice: 10_000_000n, fTs: 0n, remainingLockSecs: DAY, bidCount: 2, openedCount: 2, settledCount: 2, createdAt: 0n, budget: 950_000_000n, issuerEscrow: 952_850_000n, referencePrice: null, retireTo: "0xdead", advanceUnits: null, advanceClaim: null, advanceMinFill: null, lienId: null, closeRequestedAt: null, key: null, keySource: null, keyReceivedAt: null, revealEndsAt: null, endedAt: null, cancelReason: null, result: null,
  };
  const bid = (id: number, bidder: string, quantity: bigint, price: bigint): Bid => ({ roundId: 7n, bidId: id, bidder, side: "Sell", status: "Opened", escrow: 0n, lockedUnits: quantity, bond: 1_000_000n, fee: 0n, cash: 0n, fillQuantity: 0n, ciphertextHex: null, placedAt: null, opened: { quantity, price }, void: null });
  const bids = [bid(0, "halden.testnet", 100n * 10n ** 18n, 9_000_000n), bid(1, "tessaro.testnet", 10n * 10n ** 18n, 10_000_000n)];

  it("recomputes the spec example (asks 100 @ 9 and 10 @ 10, budget 950) and the candidate table", () => {
    const pricing = { lockedFractionE18: ONE, tokenDecimals: 18 };
    const table = candidateTable(askOrders(bids), 950_000_000n, 10_000_000n, pricing);
    expect(table.map((row) => [row.price, row.volume, row.best])).toEqual([
      [9_000_000n, 100n * 10n ** 18n, true],
      [10_000_000n, 95n * 10n ** 18n, false],
    ]);
    const result: RoundResult = { price: 9_000_000n, volume: 100n * 10n ** 18n, notional: 900_000_000n, fee: 2_700_000n, issuerCharged: 900_000_000n, issuerRefund: 50_000_000n, remainingLockSecs: DAY, fills: [] };
    expect(recompute(askOrders(bids), 950_000_000n, 10_000_000n, pricing, result)).toEqual({ outcome: "cleared", price: 9_000_000n, volume: 100n * 10n ** 18n, charged: 900_000_000n, refund: 50_000_000n, matches: true });
  });
  it("exports every section to CSV", () => {
    const csv = tenderReportCsv({ engine: "engine.rose-app.testnet", round, cls, symbol: "CINDR", bids, result: null, events: [], generatedAt: Date.UTC(2026, 10, 4) });
    const lines = csv.split("\n");
    expect(lines[0]).toBe("section,field,value,,,,");
    expect(csv).toContain("parameters,budget,950.00");
    expect(csv).toContain("asks,0,halden.testnet,100.0000,100.0000,9.000000,Opened");
    expect(csv).toContain("candidates,9.000000,100.0000,105.5555,100.0000,true,");
    expect(eventsOfRound([{ seq: 1n, blockHeight: 1n, timestamp: 0n, predecessor: "a", event: { event: "key_requested", data: { round_id: "7" } } }], 7n)).toHaveLength(1);
  });
});
