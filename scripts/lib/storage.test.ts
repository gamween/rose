import assert from "node:assert/strict";
import { test } from "node:test";
import type { Holding } from "@rose/sdk";
import { bidStorageTopUp, HOLDING_ROW_STORAGE_DEPOSIT } from "./storage.ts";

const MINIMUM = 6_190_000_000_000_000_000_000n;
const CLASS = "f91b52ceab7a9f40e6578513ddb7478ef251e90dc2ef94c5e08c6db1d04a1a42";

function holding(balance: bigint): Holding {
  return { classId: CLASS, balance, lockedInRounds: 0n, encumbered: 0n, claimable: 0n, checkpoint: 0n };
}

await test("an unregistered buyer deposits the registration minimum", () => {
  assert.equal(bidStorageTopUp(null, MINIMUM, null), MINIMUM);
});

await test("a buyer already holding the class needs nothing", () => {
  assert.equal(bidStorageTopUp({ total: MINIMUM, available: 0n }, MINIMUM, holding(5n)), 0n);
});

await test("a buyer with no room for a new holding row tops up one row", () => {
  // The live engine-s4 case: Halden Ventures holds the Seed Round and two cash rows, then bids on the Strategic Round.
  assert.equal(bidStorageTopUp({ total: 8_000_000_000_000_000_000_000n, available: 0n }, MINIMUM, null), HOLDING_ROW_STORAGE_DEPOSIT);
  assert.equal(bidStorageTopUp({ total: MINIMUM, available: 0n }, MINIMUM, holding(0n)), HOLDING_ROW_STORAGE_DEPOSIT);
});

await test("a buyer with part of a row available tops up the difference", () => {
  assert.equal(bidStorageTopUp({ total: MINIMUM, available: 1_000_000_000_000_000_000_000n }, MINIMUM, null), HOLDING_ROW_STORAGE_DEPOSIT - 1_000_000_000_000_000_000_000n);
});

await test("a buyer with a full row available needs nothing", () => {
  assert.equal(bidStorageTopUp({ total: MINIMUM, available: HOLDING_ROW_STORAGE_DEPOSIT }, MINIMUM, null), 0n);
});
