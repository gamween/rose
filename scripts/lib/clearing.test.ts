import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseRound, type Round, type RoundView } from "@rose/sdk";
import { checkClearing } from "./clearing.ts";

/** engine-v2's settled seeded Tender, Exit and Advance, as `get_round` returned them on 2026-11-14. */
const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/settled-rounds.json", import.meta.url), "utf8")) as {
  rounds: { decimals: number; view: RoundView }[];
};

function recorded(kind: Round["kind"]): { round: Round; decimals: number } {
  const entry = RECORDED.rounds.find((candidate) => candidate.view.kind === kind);
  if (entry === undefined) throw new Error(`no recorded ${kind}`);
  return { round: parseRound(entry.view), decimals: entry.decimals };
}

function withFills(round: Round, change: (fill: NonNullable<Round["result"]>["fills"][number]) => NonNullable<Round["result"]>["fills"][number]): Round {
  if (round.result === null) throw new Error("recorded round without a result");
  return { ...round, result: { ...round.result, fills: round.result.fills.map(change) } };
}

await test("the recorded settled Tender, Exit and Advance match the reference on their opened, valid orders", () => {
  // The Exit's fifth order was never opened: it is not fed to the reference.
  for (const [kind, orders] of [["Tender", 2], ["Exit", 4], ["Advance", 3]] as const) {
    const { round, decimals } = recorded(kind);
    const check = checkClearing(round, decimals);
    assert.equal(check.matches, true, kind);
    assert.notEqual(check.reference, "no_crossing", kind);
    assert.equal(check.orders, orders, kind);
  }
});

await test("one unit more cash on one fill is a mismatch", () => {
  for (const kind of ["Tender", "Exit", "Advance"] as const) {
    const { round, decimals } = recorded(kind);
    const changed = withFills(round, (fill) => (fill.bidId === 0 ? { ...fill, cash: fill.cash + 1n } : fill));
    assert.equal(checkClearing(changed, decimals).matches, false, kind);
  }
});

await test("a round recorded as settled is a mismatch once its status is not Settled", () => {
  const { round, decimals } = recorded("Tender");
  assert.equal(checkClearing({ ...round, status: "Cancelled" }, decimals).matches, false);
});

await test("a settled Tender or Exit with no opened order is a mismatch, not a pass", () => {
  for (const kind of ["Tender", "Exit"] as const) {
    const { round, decimals } = recorded(kind);
    const check = checkClearing(withFills(round, (fill) => ({ ...fill, opened: null })), decimals);
    assert.equal(check.reference, "no_crossing", kind);
    assert.equal(check.orders, 0, kind);
    assert.equal(check.matches, false, kind);
  }
});

await test("a cancelled round where nothing crosses is consistent", () => {
  const { round, decimals } = recorded("Exit");
  const cancelled = withFills({ ...round, status: "Cancelled" }, (fill) => ({ ...fill, opened: null }));
  assert.equal(checkClearing(cancelled, decimals).matches, true);
});

await test("an Advance whose reserve was never opened is refused", () => {
  const { round, decimals } = recorded("Advance");
  assert.throws(() => checkClearing(withFills(round, (fill) => ({ ...fill, opened: null })), decimals), /advance without an opened reserve/);
});
