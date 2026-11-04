import assert from "node:assert/strict";
import { test } from "node:test";
import { REUSE_MARGIN_NANOS, reusableRound } from "./rounds.ts";

const NOW = 1_793_786_000_000_000_000n;

await test("a resumed run reuses an open round that still accepts orders", () => {
  const open = { roundId: 4n, closesAt: NOW + 10n * REUSE_MARGIN_NANOS };
  assert.equal(reusableRound([open], NOW), open);
});

await test("an open round past its window is not reused: a new one is created", () => {
  // The live engine-s4 case: the no-key round 3 closed while its bid failed, and stays `Open` until `close`.
  assert.equal(reusableRound([{ roundId: 3n, closesAt: NOW - 1n }], NOW), undefined);
  assert.equal(reusableRound([{ roundId: 3n, closesAt: NOW + REUSE_MARGIN_NANOS }], NOW), undefined);
});

await test("the first round still open for orders wins over a closed one", () => {
  const live = { roundId: 5n, closesAt: NOW + 2n * REUSE_MARGIN_NANOS };
  assert.equal(reusableRound([{ roundId: 3n, closesAt: NOW - 1n }, live], NOW), live);
});
