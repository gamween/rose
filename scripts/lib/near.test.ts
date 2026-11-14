import assert from "node:assert/strict";
import { test } from "node:test";
import type { FinalExecutionOutcome } from "@rose/sdk";
import { failedBeforeSigning, sendOnce, type OneTransaction } from "./near.ts";

function syntaxErrorFrom(frames: string[]): SyntaxError {
  const error = new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
  error.stack = [`${error.name}: ${error.message}`, ...frames.map((frame) => `    at ${frame}`)].join("\n");
  return error;
}

await test("an HTML page answered while near-api-js builds the transaction is retried", () => {
  // The stack of the live engine-s4 failure (scripts/e2e-live.ts, nokey:bid).
  const error = syntaxErrorFrom(["JSON.parse (<anonymous>)", "async fetchJsonRpc (near-api-js/lib/index.js:3084:10)", "async JsonRpcProvider.sendJsonRpc (near-api-js/lib/index.js:3531:22)", "async Promise.all (index 1)", "async Account.createTransaction (near-api-js/lib/index.js:4215:44)"]);
  assert.equal(failedBeforeSigning(error), true);
});

await test("an HTML page answered to the broadcast is not taken for a failure before signing (sendOnce looks the transaction up)", () => {
  const error = syntaxErrorFrom(["JSON.parse (<anonymous>)", "async fetchJsonRpc (near-api-js/lib/index.js:3084:10)", "async JsonRpcProvider.sendTransactionUntil (near-api-js/lib/index.js:3402:12)", "async Account.signAndSendTransaction (near-api-js/lib/index.js:4260:20)"]);
  assert.equal(failedBeforeSigning(error), false);
});

await test("other errors are not retried", () => {
  assert.equal(failedBeforeSigning(new Error("Account.createTransaction: access key not found")), false);
});

const OUTCOME = { transaction: { hash: "H" } } as unknown as FinalExecutionOutcome;
const RATE_LIMITED = Object.assign(new Error("HTTP 429: Rate limits exceeded"), { cause: 429 });

/** A transaction whose sends answer `sends` in turn (an outcome or an error) and whose lookups answer `lookups`. */
function scripted(sends: (FinalExecutionOutcome | Error)[], lookups: (boolean | null)[]): OneTransaction & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    send: () => {
      calls.push("send");
      const next = sends.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? OUTCOME);
    },
    known: () => {
      calls.push("known");
      return Promise.resolve(lookups.shift() ?? null);
    },
    final: () => {
      calls.push("final");
      return Promise.resolve(OUTCOME);
    },
    wait: () => Promise.resolve(),
  };
}

await test("a send rate limited after the RPC forwarded it is not sent again: the lookup finds it and its outcome is returned", async () => {
  const transaction = scripted([RATE_LIMITED], [true]);
  assert.equal(await sendOnce("t", "H", transaction), OUTCOME);
  assert.deepEqual(transaction.calls, ["send", "known", "final"]);
});

await test("a rate-limited send the network does not know is sent again, the same signed bytes", async () => {
  const transaction = scripted([RATE_LIMITED, new TypeError("fetch failed"), OUTCOME], [false, false]);
  assert.equal(await sendOnce("t", "H", transaction), OUTCOME);
  assert.deepEqual(transaction.calls, ["send", "known", "send", "known", "send"]);
});

await test("the send is not repeated while the lookup cannot tell, and stops on the original error", async () => {
  const transaction = scripted([RATE_LIMITED], [null, null, null, null, null]);
  await assert.rejects(sendOnce("t", "H", transaction), RATE_LIMITED);
  assert.deepEqual(transaction.calls, ["send", "known", "known", "known", "known", "known"]);
});

await test("a lookup that answers on a later try still prevents a second send", async () => {
  const transaction = scripted([RATE_LIMITED], [null, true]);
  assert.equal(await sendOnce("t", "H", transaction), OUTCOME);
  assert.deepEqual(transaction.calls, ["send", "known", "known", "final"]);
});

await test("an error the transaction itself caused is not resent", async () => {
  const invalid = new Error("Transaction nonce 5 must be larger than nonce of the used access key 7");
  const transaction = scripted([invalid], [false]);
  await assert.rejects(sendOnce("t", "H", transaction), invalid);
  assert.deepEqual(transaction.calls, ["send", "known"]);
});
